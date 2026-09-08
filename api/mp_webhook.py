from http.server import BaseHTTPRequestHandler

# =====================================================================
# api/mp_webhook.py — notificações do Mercado Pago
#
# É o único endpoint do sistema em que alguém de FORA escreve na base:
# é ele que estende a validade das assinaturas. Tratado como tal.
#
# TRÊS DEFESAS, nesta ordem:
#
#   1. ASSINATURA HMAC. O Mercado Pago manda `x-signature` com um hash
#      do manifesto id/request-id/ts. Sem conferir, qualquer um faz um
#      POST aqui e ganha assinatura vitalícia de graça.
#
#   2. NÃO CONFIAR NO CORPO. A notificação diz apenas "olha o pagamento
#      X". Quanto foi pago, se foi aprovado e de quem é sai da consulta
#      à API do Mercado Pago com o access token — nunca do JSON que
#      chegou, que é controlado por quem enviou.
#
#   3. IDEMPOTÊNCIA NO BANCO. O Mercado Pago REENVIA a mesma notificação
#      quando não recebe 200 rápido: cold start da função, deploy no
#      meio, rede lenta. A função aplicar_pagamento() usa o id do
#      pagamento como chave única, então a segunda entrega vira um
#      no-op em vez de um mês grátis.
#
# CÓDIGOS DE RESPOSTA — o Mercado Pago reage a eles:
#   200  processado (ou ignorado de propósito). Ele para de reenviar.
#   401  assinatura inválida. Não reenvia.
#   500  falha temporária nossa. Ele reenvia — que é o que queremos
#        quando a API dele ou o Supabase estão fora do ar.
#
# VARIÁVEIS DE AMBIENTE (Vercel):
#   SUPABASE_URL, SUPABASE_SERVICE_KEY
#   MP_ACCESS_TOKEN      token de produção da sua aplicação
#   MP_WEBHOOK_SECRET    segredo em Suas integrações > Webhooks
# =====================================================================

import os
import json
import hmac
import time
import hashlib
import urllib.parse
import urllib.request
import urllib.error

TIMEOUT = 20
MP_API = "https://api.mercadopago.com"

# Janela de tolerância do timestamp da assinatura. Existe para impedir
# que alguém capture uma notificação válida e a reenvie meses depois.
# Cinco minutos cobre com folga o atraso normal da fila do Mercado Pago.
TOLERANCIA_S = 5 * 60


def env(nome, padrao=""):
    return os.environ.get(nome, padrao)


SUPABASE_URL = env("SUPABASE_URL")
SUPABASE_SERVICE_KEY = env("SUPABASE_SERVICE_KEY")
MP_ACCESS_TOKEN = env("MP_ACCESS_TOKEN")
MP_WEBHOOK_SECRET = env("MP_WEBHOOK_SECRET")

PLANOS_VALIDOS = ("vextron", "vexos", "combo")


# ---------------------------------------------------------------------
# Resposta
# ---------------------------------------------------------------------
def responder(handler, status, corpo=None):
    dados = json.dumps(corpo or {"ok": True}).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(dados)))
    handler.end_headers()
    handler.wfile.write(dados)


def log(*partes):
    """
    Vai para os logs da função na Vercel. Sem isto, uma assinatura
    recusada é invisível — e "o cliente pagou e não liberou" vira
    investigação às cegas.
    """
    print("[mp_webhook]", *partes, flush=True)


# ---------------------------------------------------------------------
# 1. Assinatura HMAC
# ---------------------------------------------------------------------
def _partes_assinatura(cabecalho):
    """Extrai ts e v1 de 'ts=1699...,v1=abc...'."""
    ts = v1 = ""
    for parte in (cabecalho or "").split(","):
        chave, _, valor = parte.partition("=")
        chave = chave.strip()
        if chave == "ts":
            ts = valor.strip()
        elif chave == "v1":
            v1 = valor.strip()
    return ts, v1


def assinatura_valida(handler, data_id):
    """
    Confere o x-signature. O manifesto é, na ordem exata:

        id:<data.id>;request-id:<x-request-id>;ts:<ts>;

    O data.id entra em MINÚSCULAS quando é alfanumérico — ids de ordem
    vêm em maiúsculas na notificação e em minúsculas no cálculo do
    Mercado Pago. Errar isso faz a validação falhar só em produção, com
    ids desse formato, e passar em todos os testes com id numérico.

    Campo ausente sai do manifesto em vez de virar string vazia.
    """
    if not MP_WEBHOOK_SECRET:
        # Sem segredo configurado, não há como distinguir uma
        # notificação real de uma forjada. Recusar é a única saída
        # segura — liberar "porque ainda não configurei" é exatamente
        # a brecha que a defesa existe para fechar.
        log("MP_WEBHOOK_SECRET não configurado — recusando")
        return False

    cabecalho = handler.headers.get("x-signature", "") or ""
    request_id = handler.headers.get("x-request-id", "") or ""
    ts, recebido = _partes_assinatura(cabecalho)
    if not (ts and recebido):
        log("x-signature ausente ou malformado")
        return False

    try:
        idade = abs(time.time() - int(ts))
    except ValueError:
        log("ts não numérico")
        return False
    if idade > TOLERANCIA_S:
        log("ts fora da janela:", int(idade), "s")
        return False

    partes = []
    if data_id:
        partes.append("id:%s" % (data_id.lower() if data_id.isalnum() else data_id))
    if request_id:
        partes.append("request-id:%s" % request_id)
    partes.append("ts:%s" % ts)
    manifesto = ";".join(partes) + ";"

    calculado = hmac.new(MP_WEBHOOK_SECRET.encode("utf-8"),
                         manifesto.encode("utf-8"),
                         hashlib.sha256).hexdigest()

    # compare_digest e não ==: comparação comum retorna mais cedo no
    # primeiro byte diferente, e o tempo de resposta vaza o hash.
    if not hmac.compare_digest(calculado, recebido):
        log("assinatura não confere")
        return False
    return True


# ---------------------------------------------------------------------
# 2. Consultas ao Mercado Pago
# ---------------------------------------------------------------------
def _mp_get(caminho):
    """GET na API do Mercado Pago. Devolve dict, ou None em falha."""
    req = urllib.request.Request(
        MP_API + caminho,
        headers={"Authorization": "Bearer " + MP_ACCESS_TOKEN})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        log("MP", caminho, "HTTP", e.code)
        return None
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
        log("MP", caminho, "falhou:", e)
        return None


# ---------------------------------------------------------------------
# 3. Supabase (service key — ignora RLS de propósito)
# ---------------------------------------------------------------------
def _supabase(caminho, metodo="GET", corpo=None):
    dados = json.dumps(corpo).encode("utf-8") if corpo is not None else None
    req = urllib.request.Request(
        SUPABASE_URL + caminho, data=dados, method=metodo,
        headers={
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": "Bearer " + SUPABASE_SERVICE_KEY,
            "Content-Type": "application/json",
        })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            texto = r.read().decode("utf-8")
            return json.loads(texto) if texto else None
    except urllib.error.HTTPError as e:
        try:
            log("Supabase", caminho, e.code, e.read().decode("utf-8")[:300])
        except Exception:
            log("Supabase", caminho, e.code)
        return None
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
        log("Supabase", caminho, "falhou:", e)
        return None


def aplicar(mp_id, oficina_id, plano, tipo, valor, status, preapproval, bruto):
    """
    Chama aplicar_pagamento() no banco: grava o pagamento e estende as
    assinaturas do plano numa operação só. Devolve True se algo mudou,
    False se era notificação repetida, None em falha.
    """
    r = _supabase("/rest/v1/rpc/aplicar_pagamento", "POST", {
        "p_mp_id": str(mp_id),
        "p_oficina_id": oficina_id,
        "p_plano": plano,
        "p_tipo": tipo,
        "p_valor": valor,
        "p_status": status,
        "p_preapproval": preapproval,
        "p_bruto": bruto,
    })
    return r


def assinatura_por_preapproval(preapproval_id):
    """
    Descobre oficina e plano a partir da preapproval. É o caminho do
    pagamento RECORRENTE: a cobrança mensal não carrega o
    external_reference, só o vínculo com a assinatura.
    """
    r = _supabase("/rest/v1/assinaturas?mp_preapproval_id=eq."
                  + urllib.parse.quote(preapproval_id)
                  + "&select=oficina_id,plano&limit=1")
    return r[0] if r else None


def marcar_status(preapproval_id, status):
    """Pausa/cancela as assinaturas ligadas a uma preapproval."""
    return _supabase(
        "/rest/v1/assinaturas?mp_preapproval_id=eq."
        + urllib.parse.quote(preapproval_id),
        "PATCH", {"status": status, "atualizada_em": "now()"})


# ---------------------------------------------------------------------
# 4. Referência externa: quem pagou e o quê
# ---------------------------------------------------------------------
def ler_referencia(texto):
    """
    Formato gravado no checkout: "<oficina_id>:<plano>".

    O plano é validado contra a lista conhecida antes de ir ao banco:
    o external_reference volta da API do Mercado Pago, mas foi montado
    a partir de dados que passaram pelo navegador do cliente.
    """
    if not texto or ":" not in texto:
        return None, None
    oficina_id, _, plano = texto.partition(":")
    oficina_id = oficina_id.strip()
    plano = plano.strip()
    if not oficina_id or plano not in PLANOS_VALIDOS:
        return None, None
    return oficina_id, plano


# ---------------------------------------------------------------------
# 5. Tratamento por tipo de notificação
# ---------------------------------------------------------------------
def tratar_pagamento(pagamento_id):
    """PIX avulso (e qualquer pagamento com external_reference nosso)."""
    p = _mp_get("/v1/payments/%s" % pagamento_id)
    if p is None:
        return 500, "Não foi possível consultar o pagamento."

    oficina_id, plano = ler_referencia(p.get("external_reference"))
    if not oficina_id:
        # Pagamento que não é nosso, ou de um fluxo antigo. 200 para o
        # Mercado Pago parar de reenviar algo que nunca vamos tratar.
        log("pagamento", pagamento_id, "sem referência válida — ignorado")
        return 200, "ignorado"

    resumo = {
        "id": p.get("id"),
        "status": p.get("status"),
        "status_detail": p.get("status_detail"),
        "transaction_amount": p.get("transaction_amount"),
        "payment_method_id": p.get("payment_method_id"),
        "date_approved": p.get("date_approved"),
        "external_reference": p.get("external_reference"),
    }

    r = aplicar(p.get("id"), oficina_id, plano, "pix",
                p.get("transaction_amount"), p.get("status"), None, resumo)
    if r is None:
        return 500, "Falha ao registrar o pagamento."
    log("pagamento", pagamento_id, p.get("status"), "novo" if r else "repetido")
    return 200, "ok"


def tratar_cobranca_assinatura(autorizado_id):
    """
    Cobrança mensal gerada por uma assinatura recorrente.
    O recurso authorized_payment liga a preapproval ao pagamento real.
    """
    a = _mp_get("/authorized_payments/%s" % autorizado_id)
    if a is None:
        return 500, "Não foi possível consultar a cobrança."

    preapproval_id = a.get("preapproval_id")
    if not preapproval_id:
        log("authorized_payment", autorizado_id, "sem preapproval_id")
        return 200, "ignorado"

    vinculo = assinatura_por_preapproval(preapproval_id)
    if not vinculo:
        # Assinatura criada fora deste sistema, ou o checkout não
        # chegou a gravar a preapproval. Nada a estender.
        log("preapproval", preapproval_id, "não encontrada na base")
        return 200, "ignorado"

    pagamento = a.get("payment") or {}
    # O status que vale é o do pagamento em si; o do authorized_payment
    # pode dizer "processed" com a cobrança recusada por baixo.
    status = pagamento.get("status") or a.get("status")
    mp_id = pagamento.get("id") or a.get("id")

    resumo = {
        "authorized_payment_id": a.get("id"),
        "preapproval_id": preapproval_id,
        "status": status,
        "transaction_amount": a.get("transaction_amount"),
        "date_created": a.get("date_created"),
    }

    r = aplicar(mp_id, vinculo["oficina_id"], vinculo["plano"], "recorrente",
                a.get("transaction_amount"), status, preapproval_id, resumo)
    if r is None:
        return 500, "Falha ao registrar a cobrança."
    log("recorrente", mp_id, status, "novo" if r else "repetido")
    return 200, "ok"


def tratar_assinatura(preapproval_id):
    """
    Mudança de estado da assinatura: autorizada, pausada, cancelada.

    Não mexe em validade. Quem cancela no meio do mês continua com o
    acesso que já pagou até vencer — tirar na hora seria cobrar por um
    serviço não prestado.
    """
    a = _mp_get("/preapproval/%s" % preapproval_id)
    if a is None:
        return 500, "Não foi possível consultar a assinatura."

    estado = (a.get("status") or "").lower()
    log("preapproval", preapproval_id, "status", estado)

    if estado == "cancelled":
        marcar_status(preapproval_id, "cancelada")
    elif estado == "paused":
        # 'vencida' e não 'cancelada': pausa costuma ser cartão que
        # falhou, e o cliente volta ao normal quando regulariza.
        marcar_status(preapproval_id, "vencida")
    # 'authorized' não faz nada aqui: quem ativa é o pagamento, não a
    # autorização. Assinatura autorizada sem cobrança aprovada não é
    # mês pago.
    return 200, "ok"


# ---------------------------------------------------------------------
# 6. Entrada
# ---------------------------------------------------------------------
def tratar(handler):
    if not (SUPABASE_URL and SUPABASE_SERVICE_KEY and MP_ACCESS_TOKEN):
        log("backend não configurado")
        return 500, "Backend não configurado."

    consulta = urllib.parse.parse_qs(
        urllib.parse.urlparse(handler.path).query)

    def q(nome):
        v = consulta.get(nome)
        return v[0] if v else ""

    try:
        tam = int(handler.headers.get("Content-Length") or 0)
        corpo = json.loads(handler.rfile.read(tam).decode("utf-8")) if tam else {}
    except (ValueError, OSError):
        corpo = {}

    # O id vem na query em algumas notificações e no corpo em outras.
    # A ASSINATURA é calculada sobre o da query — usar o do corpo aqui
    # faz a validação falhar de forma intermitente.
    data_id = q("data.id") or q("id")
    if not assinatura_valida(handler, data_id):
        return 401, "Assinatura inválida."

    recurso = data_id or str((corpo.get("data") or {}).get("id") or "")
    tipo = (q("type") or q("topic") or corpo.get("type")
            or corpo.get("topic") or "").lower()

    if not recurso:
        return 200, "sem recurso"

    if tipo in ("payment",):
        return tratar_pagamento(recurso)
    if tipo in ("subscription_authorized_payment",):
        return tratar_cobranca_assinatura(recurso)
    if tipo in ("subscription_preapproval", "preapproval"):
        return tratar_assinatura(recurso)

    # Tipo desconhecido: 200 para não entrar em ciclo de reenvio de algo
    # que este endpoint não trata (test webhooks, merchant_order etc).
    log("tipo ignorado:", tipo)
    return 200, "ignorado"


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            status, mensagem = tratar(self)
        except Exception as e:
            # Nunca deixar a exceção subir: o Mercado Pago trata 502 da
            # plataforma igual a 500, mas o log some. Aqui fica.
            log("erro inesperado:", repr(e))
            status, mensagem = 500, "Erro interno."
        responder(self, status, {"ok": status == 200, "detalhe": mensagem})

    def do_GET(self):
        # Útil para conferir que a rota subiu, sem revelar nada.
        responder(self, 200, {"ok": True, "servico": "mp_webhook"})

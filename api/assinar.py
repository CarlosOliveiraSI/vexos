from http.server import BaseHTTPRequestHandler

# =====================================================================
# api/assinar.py — cria a cobrança da assinatura no Mercado Pago
#
# Chamado pela tela assinatura.html, com o token do usuário logado.
# Dois caminhos:
#
#   recorrente  cria uma preapproval e devolve o link onde o cliente
#               cadastra o cartão. A partir daí o Mercado Pago cobra
#               sozinho todo mês.
#   pix         cria um pagamento avulso e devolve o QR Code. Dura 30
#               dias; para continuar, o cliente paga de novo.
#
# O QUE NUNCA VEM DO NAVEGADOR
#
#   oficina_id  sai do token, sempre. Se viesse no corpo, qualquer um
#               pagaria R$ 1 e creditaria na oficina do vizinho — ou
#               pior, mandaria o external_reference de outra oficina.
#   preço       sai da tabela `planos`. Se viesse no corpo, o cliente
#               editava o JavaScript e assinava o combo por R$ 0,01.
#
# O corpo só decide DUAS coisas: qual plano e qual forma de pagamento.
# E o plano é conferido contra a tabela antes de virar cobrança.
#
# VARIÁVEIS DE AMBIENTE (Vercel):
#   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY
#   MP_ACCESS_TOKEN
#   VEXOS_URL   endereço público do sistema, p/ o retorno do checkout
#               ex.: https://vexos-bay.vercel.app
# =====================================================================

import os
import json
import uuid
import urllib.parse
import urllib.request
import urllib.error

TIMEOUT = 30
MP_API = "https://api.mercadopago.com"


def env(nome, padrao=""):
    return os.environ.get(nome, padrao)


SUPABASE_URL = env("SUPABASE_URL")
SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY")
SUPABASE_SERVICE_KEY = env("SUPABASE_SERVICE_KEY")
MP_ACCESS_TOKEN = env("MP_ACCESS_TOKEN")
VEXOS_URL = env("VEXOS_URL", "https://vexos-bay.vercel.app").rstrip("/")

FORMAS = ("recorrente", "pix")


# ---------------------------------------------------------------------
# Resposta
# ---------------------------------------------------------------------
def resposta(status, corpo):
    return {"statusCode": status,
            "headers": {"Content-Type": "application/json; charset=utf-8"},
            "body": json.dumps(corpo, ensure_ascii=False)}


def erro(status, mensagem):
    return resposta(status, {"erro": mensagem})


def responder_handler(handler, r):
    corpo = r["body"].encode("utf-8")
    handler.send_response(r["statusCode"])
    for chave, valor in r["headers"].items():
        handler.send_header(chave, valor)
    handler.send_header("Content-Length", str(len(corpo)))
    handler.end_headers()
    handler.wfile.write(corpo)


def log(*partes):
    print("[assinar]", *partes, flush=True)


# ---------------------------------------------------------------------
# Quem está pedindo
# ---------------------------------------------------------------------
def extrair_token(handler):
    auth = (handler.headers.get("Authorization", "") or "")
    return auth[7:].strip() if auth.lower().startswith("bearer ") else ""


def _usuario_do_token(token):
    """Confirma o token no Supabase. Devolve (id, email) ou (None, None)."""
    if not (SUPABASE_URL and token):
        return None, None
    req = urllib.request.Request(
        SUPABASE_URL + "/auth/v1/user",
        headers={"apikey": SUPABASE_ANON_KEY,
                 "Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            d = json.loads(r.read().decode("utf-8"))
            return d.get("id"), d.get("email")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
            ValueError, OSError):
        return None, None


def _supabase(caminho, metodo="GET", corpo=None, prefer=None):
    dados = json.dumps(corpo).encode("utf-8") if corpo is not None else None
    cab = {"apikey": SUPABASE_SERVICE_KEY,
           "Authorization": "Bearer " + SUPABASE_SERVICE_KEY,
           "Content-Type": "application/json"}
    if prefer:
        cab["Prefer"] = prefer
    req = urllib.request.Request(SUPABASE_URL + caminho, data=dados,
                                 method=metodo, headers=cab)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            texto = r.read().decode("utf-8")
            return json.loads(texto) if texto else []
    except urllib.error.HTTPError as e:
        try:
            log("Supabase", caminho, e.code, e.read().decode("utf-8")[:300])
        except Exception:
            log("Supabase", caminho, e.code)
        return None
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
        log("Supabase", caminho, "falhou:", e)
        return None


def _perfil_gestor(id_usuario):
    """
    Só dono e admin contratam. O técnico usa o sistema, não assina o
    contrato — e assinatura é compromisso financeiro da empresa.
    """
    r = _supabase("/rest/v1/perfis?id=eq.%s&select=oficina_id,papel,ativo"
                  % id_usuario)
    if not r:
        return None
    p = r[0]
    if not p.get("ativo") or p.get("papel") not in ("dono", "admin"):
        return None
    return p.get("oficina_id")


def _plano(codigo):
    r = _supabase("/rest/v1/planos?codigo=eq.%s&ativo=is.true"
                  "&select=codigo,nome,preco,modulos,dias,mp_plan_id"
                  % urllib.parse.quote(codigo))
    return r[0] if r else None


def _assinaturas_da_oficina(oficina_id):
    r = _supabase("/rest/v1/assinaturas?oficina_id=eq.%s"
                  "&select=modulo,plano,status,validade,origem,"
                  "mp_preapproval_id" % oficina_id)
    return r or []


def _oficina(oficina_id):
    r = _supabase("/rest/v1/oficinas?id=eq.%s&select=nome,email,telefone"
                  % oficina_id)
    return r[0] if r else {}


# ---------------------------------------------------------------------
# Mercado Pago
# ---------------------------------------------------------------------
def _mp(caminho, corpo=None, metodo="POST", idempotencia=None):
    """Devolve (dados, codigo). codigo 0 = nem houve resposta HTTP."""
    cab = {"Authorization": "Bearer " + MP_ACCESS_TOKEN,
           "Content-Type": "application/json"}
    if idempotencia:
        # Se a resposta se perder na volta, a tela tenta de novo e o
        # Mercado Pago devolve a MESMA cobrança em vez de criar outra.
        cab["X-Idempotency-Key"] = idempotencia
    dados = json.dumps(corpo).encode("utf-8") if corpo is not None else None
    req = urllib.request.Request(MP_API + caminho, data=dados,
                                 method=metodo, headers=cab)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            texto = r.read().decode("utf-8")
            return (json.loads(texto) if texto else {}), r.status
    except urllib.error.HTTPError as e:
        try:
            detalhe = e.read().decode("utf-8")[:500]
        except Exception:
            detalhe = ""
        log("MP", caminho, e.code, detalhe)
        return None, e.code
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
        log("MP", caminho, "falhou:", e)
        return None, 0


def _cancelar_preapproval(preapproval_id):
    """
    Encerra uma assinatura recorrente no Mercado Pago. Melhor esforço:
    se falhar, o pior caso é uma cobrança a mais, que você estorna —
    e é preferível a travar o upgrade do cliente aqui.
    """
    if not preapproval_id:
        return
    _mp("/preapproval/%s" % preapproval_id, {"status": "cancelled"}, "PUT")


# ---------------------------------------------------------------------
# Regras de negócio
# ---------------------------------------------------------------------
def ja_contratado(assinaturas, codigo_plano):
    """
    A oficina já PAGA este plano?

    Pergunta diferente de "os módulos dele estão cobertos". Quem paga
    Vextron e VexOS separados tem os dois módulos ativos, mas não
    assinou o combo — e trocar os avulsos pelo pacote é uma contratação
    legítima, geralmente mais barata. Confundir as duas coisas bloqueia
    justamente o upgrade que interessa vender.
    """
    return any(a.get("plano") == codigo_plano and a.get("status") == "ativa"
               for a in assinaturas)


def conflitos(assinaturas, modulos_novos):
    """
    Módulos que a oficina JÁ tem ativos e que o plano novo repetiria.
    Usado só para saber o que precisa ser cancelado na troca.
    """
    ativos = {a["modulo"]: a for a in assinaturas
              if a.get("status") == "ativa"}
    return [m for m in modulos_novos if m in ativos]


def preapprovals_a_cancelar(assinaturas, modulos_novos):
    """
    Assinaturas recorrentes ATIVAS que ficam órfãs com o plano novo.

    Quem paga o Vextron no cartão e sobe para o combo não pode continuar
    pagando as duas: a preapproval antiga é cancelada no Mercado Pago,
    senão o cartão é debitado duas vezes por mês.

    Só considera linha ATIVA com origem recorrente — ou seja, algo que
    de fato já foi pago. Intenção não paga não tem o que cancelar aqui;
    ela nem aparece mais nesta tabela.
    """
    ids = set()
    for a in assinaturas:
        if (a.get("modulo") in modulos_novos
                and a.get("origem") == "recorrente"
                and a.get("status") == "ativa"
                and a.get("mp_preapproval_id")):
            ids.add(a["mp_preapproval_id"])
    return list(ids)


def registrar_preapproval(mp_id, oficina_id, plano):
    """
    Grava o vínculo preapproval -> (oficina, plano) ANTES do primeiro
    pagamento. Sem ele, a cobrança mensal chega no webhook sem
    external_reference e não há como saber de quem é.

    Vai para a tabela `preapprovals`, NUNCA para `assinaturas`. A versão
    anterior escrevia em `assinaturas` e sobrescrevia plano e origem de
    linhas já pagas — uma intenção de compra alterava um direito já
    adquirido. `assinaturas` agora só é escrita por pagamento aprovado.
    """
    return _supabase(
        "/rest/v1/preapprovals?on_conflict=mp_id",
        "POST",
        [{"mp_id": mp_id, "oficina_id": oficina_id, "plano": plano}],
        prefer="resolution=merge-duplicates,return=minimal")


# ---------------------------------------------------------------------
# Criação da cobrança
# ---------------------------------------------------------------------
def criar_recorrente(oficina_id, plano, email, nome_oficina):
    referencia = "%s:%s" % (oficina_id, plano["codigo"])
    corpo = {
        "reason": "Motronix — %s" % plano["nome"],
        "external_reference": referencia,
        "payer_email": email,
        "back_url": VEXOS_URL + "/assinatura.html",
        "status": "pending",
        "auto_recurring": {
            "frequency": 1,
            "frequency_type": "months",
            "transaction_amount": float(plano["preco"]),
            "currency_id": "BRL",
        },
    }
    if plano.get("mp_plan_id"):
        corpo["preapproval_plan_id"] = plano["mp_plan_id"]

    dados, codigo = _mp("/preapproval", corpo,
                        idempotencia=str(uuid.uuid4()))
    if dados is None:
        if codigo == 400:
            return None, ("O Mercado Pago recusou os dados da assinatura. "
                          "Confira o e-mail informado e o valor do plano.")
        return None, "Não foi possível criar a assinatura agora."

    preapproval_id = dados.get("id")
    if not preapproval_id:
        return None, "O Mercado Pago não devolveu a assinatura."

    if registrar_preapproval(preapproval_id, oficina_id,
                             plano["codigo"]) is None:
        # A preapproval existe lá e não foi registrada aqui: cancelar é
        # melhor do que deixar uma cobrança que o webhook nunca vai
        # saber creditar.
        _cancelar_preapproval(preapproval_id)
        return None, "Falha ao registrar a assinatura. Tente novamente."

    return {
        "forma": "recorrente",
        "preapproval_id": preapproval_id,
        "link": dados.get("init_point") or dados.get("sandbox_init_point"),
    }, None


def criar_pix(oficina_id, plano, email, nome_oficina):
    referencia = "%s:%s" % (oficina_id, plano["codigo"])
    corpo = {
        "transaction_amount": float(plano["preco"]),
        "payment_method_id": "pix",
        "description": "Motronix — %s (%s dias)" % (plano["nome"],
                                                    plano["dias"]),
        "external_reference": referencia,
        "notification_url": VEXOS_URL + "/api/mp_webhook",
        "payer": {"email": email},
    }
    dados, codigo = _mp("/v1/payments", corpo,
                        idempotencia=str(uuid.uuid4()))
    if dados is None:
        return None, "Não foi possível gerar o PIX agora."

    interacao = (dados.get("point_of_interaction") or {})
    transacao = (interacao.get("transaction_data") or {})
    if not transacao.get("qr_code"):
        return None, "O Mercado Pago não devolveu o código PIX."

    return {
        "forma": "pix",
        "pagamento_id": dados.get("id"),
        "copia_e_cola": transacao.get("qr_code"),
        "qr_base64": transacao.get("qr_code_base64"),
        "expira_em": dados.get("date_of_expiration"),
    }, None


# ---------------------------------------------------------------------
# Entrada
# ---------------------------------------------------------------------
def tratar(handler):
    if not (SUPABASE_URL and SUPABASE_SERVICE_KEY and MP_ACCESS_TOKEN):
        return erro(500, "Backend não configurado.")

    token = extrair_token(handler)
    id_usuario, email_login = _usuario_do_token(token)
    if not id_usuario:
        return erro(401, "Não autenticado.")

    oficina_id = _perfil_gestor(id_usuario)
    if not oficina_id:
        return erro(403, "Apenas o dono ou administrador pode assinar.")

    try:
        tam = int(handler.headers.get("Content-Length") or 0)
        dados = json.loads(handler.rfile.read(tam).decode("utf-8")) if tam else {}
    except (ValueError, OSError):
        return erro(400, "Requisição inválida.")

    codigo = (dados.get("plano") or "").strip()
    forma = (dados.get("forma") or "recorrente").strip()
    if forma not in FORMAS:
        return erro(400, "Forma de pagamento inválida.")

    plano = _plano(codigo)
    if not plano:
        return erro(400, "Plano inválido.")
    if not plano.get("preco") or float(plano["preco"]) <= 0:
        # Preço zerado é o estado inicial da tabela. Cobrar R$ 0,00
        # criaria uma assinatura que nunca gera pagamento — e nunca
        # libera nada, porque quem libera é o pagamento aprovado.
        return erro(409, "Este plano ainda não tem preço definido.")

    atuais = _assinaturas_da_oficina(oficina_id)
    if atuais is None:
        return erro(500, "Não foi possível ler sua assinatura atual.")

    # Bloqueia só recontratar o MESMO plano. Trocar dois avulsos pelo
    # combo continua permitido — o cancelamento das assinaturas antigas
    # acontece logo abaixo.
    if ja_contratado(atuais, plano["codigo"]):
        return erro(409, "Você já tem esse plano ativo.")

    oficina = _oficina(oficina_id) or {}
    # E-mail do pagador: o da oficina, se cadastrado; senão o do login.
    email = (oficina.get("email") or email_login or "").strip()
    if not email or "@" not in email:
        return erro(400, "Cadastre um e-mail válido em Dados da oficina "
                         "antes de assinar.")

    if forma == "recorrente":
        # Upgrade: cancela a recorrência antiga ANTES de criar a nova,
        # senão o cartão do cliente é debitado duas vezes por mês.
        for antiga in preapprovals_a_cancelar(atuais, plano["modulos"]):
            _cancelar_preapproval(antiga)
        saida, msg = criar_recorrente(oficina_id, plano, email,
                                      oficina.get("nome"))
    else:
        saida, msg = criar_pix(oficina_id, plano, email, oficina.get("nome"))

    if msg:
        return erro(502, msg)

    saida["plano"] = plano["codigo"]
    saida["nome"] = plano["nome"]
    saida["preco"] = float(plano["preco"])
    return resposta(201, saida)


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            r = tratar(self)
        except Exception as e:
            log("erro inesperado:", repr(e))
            r = erro(500, "Erro interno.")
        responder_handler(self, r)

    def do_GET(self):
        responder_handler(self, erro(405, "Use POST."))

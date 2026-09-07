from http.server import BaseHTTPRequestHandler

# =====================================================================
# api/usuarios.py — cadastro de usuários da oficina (VexOS)
#
# O DONO ou admin cadastra um funcionário informando nome, e-mail, senha
# e papel. Criar a CONTA DE LOGIN exige a service key do Supabase, que
# só vive aqui no backend — por isso este endpoint existe (a tela não
# consegue criar login sozinha, por segurança).
#
# O que ele garante:
#   - quem chama tem de ser gestor (dono/admin) de uma oficina;
#   - o usuário novo entra na oficina DE QUEM CHAMA (o oficina_id sai do
#     token, nunca do corpo — senão daria para criar gente na oficina
#     alheia);
#   - o papel novo só pode ser dono/tecnico/atendente. 'admin' é papel
#     interno de teste e NÃO é aceito aqui, mesmo que a tela mande;
#   - login e perfil são criados juntos: se o perfil falhar, a conta de
#     login recém-criada é apagada, para não sobrar login órfão.
# =====================================================================

import os
import json
import urllib.parse
import urllib.request
import urllib.error

TIMEOUT = 30


def env(nome, padrao=""):
    return os.environ.get(nome, padrao)


SUPABASE_URL = env("SUPABASE_URL")
SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY")
SUPABASE_SERVICE_KEY = env("SUPABASE_SERVICE_KEY")

# papéis que o cadastro comercial pode criar. 'admin' de fora: é interno.
PAPEIS_PERMITIDOS = ("dono", "tecnico", "atendente")


# ---------------------------------------------------------------------
# Respostas
# ---------------------------------------------------------------------
def resposta(status, corpo):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json; charset=utf-8"},
        "body": json.dumps(corpo, ensure_ascii=False),
    }


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


# ---------------------------------------------------------------------
# Auth de quem chama
# ---------------------------------------------------------------------
def extrair_token(handler):
    headers = getattr(handler, "headers", None)
    if headers is None:
        return ""
    auth = headers.get("Authorization", "") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return ""


def _usuario_do_token(token):
    """Confirma o token no Supabase e devolve o id do usuário (ou None)."""
    if not (SUPABASE_URL and token):
        return None
    req = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/user",
        headers={"apikey": SUPABASE_ANON_KEY,
                 "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8")).get("id")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
            ValueError, OSError):
        return None


def _perfil_gestor(id_usuario):
    """
    Lê o perfil de quem chama COM A SERVICE KEY (ignora RLS) e só devolve
    (oficina_id) se a pessoa for gestor ativo. Caso contrário, None.
    """
    if not (SUPABASE_URL and SUPABASE_SERVICE_KEY and id_usuario):
        return None
    url = (f"{SUPABASE_URL}/rest/v1/perfis"
           f"?id=eq.{id_usuario}&select=oficina_id,papel,ativo")
    req = urllib.request.Request(url, headers={
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            linhas = json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
            ValueError, OSError):
        return None
    if not linhas:
        return None
    p = linhas[0]
    if not p.get("ativo") or p.get("papel") not in ("dono", "admin"):
        return None
    return p.get("oficina_id")


# ---------------------------------------------------------------------
# Criação de login + perfil (service key)
# ---------------------------------------------------------------------
def _criar_login(email, senha):
    """
    Cria a conta de autenticação. Devolve (id, None) em sucesso, ou
    (None, mensagem) em erro — inclusive e-mail já em uso.
    """
    url = f"{SUPABASE_URL}/auth/v1/admin/users"
    corpo = json.dumps({
        "email": email,
        "password": senha,
        "email_confirm": True,   # dono já entrega a senha; não exige e-mail
    }).encode("utf-8")
    req = urllib.request.Request(url, data=corpo, method="POST", headers={
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            dados = json.loads(r.read().decode("utf-8"))
        return dados.get("id"), None
    except urllib.error.HTTPError as e:
        try:
            det = json.loads(e.read().decode("utf-8"))
            msg = det.get("msg") or det.get("error_description") or det.get("error") or ""
        except Exception:
            msg = ""
        if e.code in (422, 409) or "already" in msg.lower() or "registered" in msg.lower():
            return None, "Já existe um usuário com esse e-mail."
        return None, "Não foi possível criar o login."
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return None, "Falha de conexão ao criar o login."


def _apagar_login(id_usuario):
    """Desfaz um login recém-criado (rollback quando o perfil falha)."""
    if not id_usuario:
        return
    url = f"{SUPABASE_URL}/auth/v1/admin/users/{id_usuario}"
    req = urllib.request.Request(url, method="DELETE", headers={
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    })
    try:
        urllib.request.urlopen(req, timeout=TIMEOUT).read()
    except Exception:
        pass  # melhor esforço; nada a fazer se falhar


def _criar_perfil(id_usuario, oficina_id, nome, papel):
    """Insere o perfil vinculando o novo usuário à oficina. bool de sucesso."""
    url = f"{SUPABASE_URL}/rest/v1/perfis"
    corpo = json.dumps({
        "id": id_usuario,
        "oficina_id": oficina_id,
        "nome": nome,
        "papel": papel,
        "ativo": True,
    }).encode("utf-8")
    req = urllib.request.Request(url, data=corpo, method="POST", headers={
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status in (200, 201)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError):
        return False


def _validar_entrada(dados):
    """Devolve (limpo, None) ou (None, mensagem de erro)."""
    email = (dados.get("email") or "").strip().lower()
    senha = dados.get("senha") or ""
    nome = (dados.get("nome") or "").strip()
    papel = (dados.get("papel") or "").strip()

    if not email or "@" not in email:
        return None, "Informe um e-mail válido."
    # o cadastro comercial usa só o domínio da empresa — trava aqui
    # também, não só na tela (defesa no servidor).
    if not email.endswith("@motronixtech.com.br"):
        return None, "O e-mail deve ser do domínio @motronixtech.com.br."
    if len(senha) < 6:
        return None, "A senha precisa ter ao menos 6 caracteres."
    if not nome:
        return None, "Informe o nome do usuário."
    if papel not in PAPEIS_PERMITIDOS:
        return None, "Papel inválido."
    return {"email": email, "senha": senha, "nome": nome, "papel": papel}, None


def tratar(handler):
    if not (SUPABASE_URL and SUPABASE_SERVICE_KEY):
        return erro(500, "Backend não configurado.")

    # 1. quem está pedindo?
    token = extrair_token(handler)
    id_gestor = _usuario_do_token(token)
    if not id_gestor:
        return erro(401, "Não autenticado.")

    # 2. é gestor de uma oficina? qual?
    oficina_id = _perfil_gestor(id_gestor)
    if not oficina_id:
        return erro(403, "Apenas o dono ou administrador pode cadastrar usuários.")

    # 3. corpo
    try:
        tam = int(handler.headers.get("Content-Length") or 0)
        dados = json.loads(handler.rfile.read(tam).decode("utf-8")) if tam else {}
    except (ValueError, OSError):
        return erro(400, "Requisição inválida.")

    limpo, msg = _validar_entrada(dados)
    if msg:
        return erro(400, msg)

    # 4. cria login; se der certo, cria perfil; se o perfil falhar, desfaz.
    id_novo, msg = _criar_login(limpo["email"], limpo["senha"])
    if msg:
        return erro(400, msg)

    if not _criar_perfil(id_novo, oficina_id, limpo["nome"], limpo["papel"]):
        _apagar_login(id_novo)   # rollback: não deixa login sem perfil
        return erro(500, "Não foi possível concluir o cadastro.")

    return resposta(201, {"ok": True, "id": id_novo,
                          "nome": limpo["nome"], "papel": limpo["papel"]})


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        responder_handler(self, tratar(self))

    def do_GET(self):
        responder_handler(self, erro(405, "Use POST."))

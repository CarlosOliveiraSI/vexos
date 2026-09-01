-- =====================================================================
-- Contas e assinaturas — Motronix Vextron
--
-- Substitui o modelo de "chave de licença". A assinatura passa a
-- pertencer a uma OFICINA, e as pessoas entram com e-mail e senha.
--
-- Por que oficina e não usuário: uma oficina tem dono, atendente e
-- técnico, e a assinatura é da empresa, não da pessoa. Modelando assim
-- desde já, o sistema web de ordens de serviço encaixa sem migração —
-- cliente, veículo e OS penduram na oficina, e cada funcionário vê o
-- que lhe cabe.
--
-- A autenticação em si (e-mail, senha, recuperação) fica com o Supabase
-- Auth, na tabela auth.users. Aqui só guardamos o que é do negócio.
--
-- Rodar no SQL Editor do painel do Supabase.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Oficinas — quem assina
-- ---------------------------------------------------------------------
create table if not exists oficinas (
    id              uuid primary key default gen_random_uuid(),
    nome            text not null,
    documento       text,                  -- CNPJ/CPF, opcional
    telefone        text,

    -- 'ativa'      assinatura em dia
    -- 'suspensa'   pagamento falhou; o app entra em modo leitura
    -- 'cancelada'  encerrada
    status          text not null default 'ativa'
                    check (status in ('ativa', 'suspensa', 'cancelada')),

    -- Até quando vale. O webhook do Mercado Pago empurra esta data a
    -- cada cobrança aprovada. Também serve para período de teste.
    validade        timestamptz not null,

    -- Computadores simultâneos. Duas: uma só gera chamado toda vez que
    -- o cliente troca de máquina; mais facilita repasse da conta.
    max_maquinas    integer not null default 2,

    mp_preapproval_id text,                -- assinatura no Mercado Pago
    observacoes     text,
    criada_em       timestamptz not null default now(),
    atualizada_em   timestamptz not null default now()
);

create index if not exists idx_oficinas_mp
    on oficinas (mp_preapproval_id) where mp_preapproval_id is not null;


-- ---------------------------------------------------------------------
-- 2. Perfis — liga a pessoa do Supabase Auth à oficina
--
-- O `papel` já existe pensando no web: no desktop todo mundo faz o
-- mesmo, mas na tela de ordens de serviço o atendente não precisa
-- (nem deve) mexer em arquivo de ECU.
-- ---------------------------------------------------------------------
create table if not exists perfis (
    id          uuid primary key references auth.users(id) on delete cascade,
    oficina_id  uuid not null references oficinas(id) on delete cascade,
    nome        text,
    papel       text not null default 'tecnico'
                check (papel in ('dono', 'tecnico', 'atendente')),
    ativo       boolean not null default true,
    criado_em   timestamptz not null default now()
);

create index if not exists idx_perfis_oficina on perfis (oficina_id);


-- ---------------------------------------------------------------------
-- 3. Máquinas ativadas
--
-- A impressão é um hash de identificadores do computador. Não
-- identifica a pessoa e não dá para reverter em número de série.
-- ---------------------------------------------------------------------
create table if not exists oficina_maquinas (
    oficina_id      uuid not null references oficinas(id) on delete cascade,
    impressao       text not null,
    nome_maquina    text,
    primeiro_uso    timestamptz not null default now(),
    ultimo_uso      timestamptz not null default now(),
    primary key (oficina_id, impressao)
);


-- ---------------------------------------------------------------------
-- 4. Segurança
--
-- RLS ligado em tudo. Cada pessoa enxerga apenas a própria oficina —
-- sem isso, um cliente com a chave anônima (que viaja dentro do app)
-- leria a base inteira de assinantes.
-- ---------------------------------------------------------------------
alter table oficinas enable row level security;
alter table perfis enable row level security;
alter table oficina_maquinas enable row level security;

-- Descobre a oficina de quem está autenticado. STABLE e security
-- definer para poder ser usada dentro das próprias políticas sem
-- recursão infinita.
create or replace function minha_oficina()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
    select oficina_id from perfis where id = auth.uid() and ativo;
$$;

drop policy if exists "ve a propria oficina" on oficinas;
create policy "ve a propria oficina" on oficinas
    for select using (id = minha_oficina());

drop policy if exists "ve os colegas" on perfis;
create policy "ve os colegas" on perfis
    for select using (oficina_id = minha_oficina());

drop policy if exists "ve as maquinas da oficina" on oficina_maquinas;
create policy "ve as maquinas da oficina" on oficina_maquinas
    for select using (oficina_id = minha_oficina());


-- ---------------------------------------------------------------------
-- 5. Validação de acesso
--
-- Chamada pelo app COM O TOKEN DO USUÁRIO. Quem é a pessoa vem do
-- próprio token (auth.uid()), não de parâmetro — assim ninguém pode
-- pedir validação em nome de outro.
--
-- Registrar a máquina e contar o limite numa operação só evita corrida:
-- dois computadores ativando ao mesmo tempo poderiam passar das duas
-- vagas se contagem e inserção fossem separadas.
-- ---------------------------------------------------------------------
create or replace function validar_acesso(
    p_impressao text,
    p_nome_maquina text default null
)
returns table (
    liberado boolean,
    motivo text,
    oficina text,
    status text,
    validade timestamptz,
    maquinas_usadas integer,
    max_maquinas integer,
    papel text
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_perfil perfis%rowtype;
    v_of oficinas%rowtype;
    v_usadas integer;
    v_conhecida boolean;
begin
    select * into v_perfil from perfis where id = auth.uid();

    if not found or not v_perfil.ativo then
        return query select false, 'sem_perfil', null::text, null::text,
                            null::timestamptz, 0, 0, null::text;
        return;
    end if;

    select * into v_of from oficinas where id = v_perfil.oficina_id;
    if not found then
        return query select false, 'sem_oficina', null::text, null::text,
                            null::timestamptz, 0, 0, v_perfil.papel;
        return;
    end if;

    select exists(
        select 1 from oficina_maquinas
        where oficina_id = v_of.id and impressao = p_impressao
    ) into v_conhecida;

    select count(*)::integer into v_usadas
    from oficina_maquinas where oficina_id = v_of.id;

    -- Só barra computador NOVO. Quem já estava registrado continua
    -- entrando mesmo com as vagas cheias — senão o cliente perderia
    -- acesso na própria máquina de sempre.
    if not v_conhecida and v_usadas >= v_of.max_maquinas then
        return query select false, 'limite_maquinas', v_of.nome, v_of.status,
                            v_of.validade, v_usadas, v_of.max_maquinas,
                            v_perfil.papel;
        return;
    end if;

    if v_of.status = 'cancelada' then
        return query select false, 'cancelada', v_of.nome, v_of.status,
                            v_of.validade, v_usadas, v_of.max_maquinas,
                            v_perfil.papel;
        return;
    end if;

    if v_of.status = 'suspensa' or v_of.validade < now() then
        -- Modo leitura, não bloqueio: as funções locais continuam.
        -- Cortar tudo por atraso faz o cliente cancelar em vez de
        -- regularizar.
        return query select false, 'vencida', v_of.nome, v_of.status,
                            v_of.validade, v_usadas, v_of.max_maquinas,
                            v_perfil.papel;
        return;
    end if;

    insert into oficina_maquinas (oficina_id, impressao, nome_maquina)
    values (v_of.id, p_impressao, p_nome_maquina)
    on conflict (oficina_id, impressao) do update
        set ultimo_uso = now(),
            nome_maquina = coalesce(excluded.nome_maquina,
                                    oficina_maquinas.nome_maquina);

    select count(*)::integer into v_usadas
    from oficina_maquinas where oficina_id = v_of.id;

    return query select true, 'ok', v_of.nome, v_of.status, v_of.validade,
                        v_usadas, v_of.max_maquinas, v_perfil.papel;
end;
$$;

grant execute on function validar_acesso(text, text) to authenticated;


-- =====================================================================
-- USO NO DIA A DIA
-- =====================================================================

-- Cadastrar uma oficina nova (assinatura mensal de 30 dias):
--
-- insert into oficinas (nome, telefone, validade)
-- values ('Oficina do Carlos', '35999998888', now() + interval '30 days')
-- returning id;
--
-- Depois crie o usuário pelo painel (Authentication > Add user) e ligue:
--
-- insert into perfis (id, oficina_id, nome, papel)
-- values ('<uuid-do-usuario>', '<uuid-da-oficina>', 'Carlos', 'dono');

-- Renovar manualmente (enquanto o webhook não estiver pronto):
--
-- update oficinas
-- set validade = greatest(validade, now()) + interval '30 days',
--     status = 'ativa', atualizada_em = now()
-- where id = '<uuid>';

-- Cliente trocou de computador e bateu no limite — liberar a vaga:
--
-- delete from oficina_maquinas where oficina_id = '<uuid>';

-- Quem vence nos próximos 7 dias:
--
-- select nome, validade, status from oficinas
-- where status = 'ativa' and validade < now() + interval '7 days'
-- order by validade;

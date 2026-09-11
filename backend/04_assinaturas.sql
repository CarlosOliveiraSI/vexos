-- =====================================================================
-- VexOS / Vextron — Assinaturas (Mercado Pago)
--
-- Rodar no SQL Editor do Supabase, DEPOIS de 01_contas.sql, 02_vexos.sql
-- e 03_oficina.sql.
--
-- PLANO x MÓDULO — a distinção que sustenta o resto
--
-- São três planos à venda: Vextron, VexOS e o combo com os dois. Se
-- plano fosse a mesma coisa que módulo, o combo não caberia: ele é UMA
-- cobrança que libera DUAS coisas.
--
--     PLANO   é o que o cliente compra e o que o Mercado Pago cobra.
--     MÓDULO  é o que o sistema libera.
--
--     vextron -> {vextron}
--     vexos   -> {vexos}
--     combo   -> {vextron, vexos}
--
-- Um pagamento do combo estende as DUAS assinaturas. O `tem_modulo()`
-- continua perguntando só pelo módulo e não sabe que combo existe —
-- é o que mantém as políticas de RLS já escritas intocadas.
--
-- Até aqui a assinatura era da OFICINA: uma `validade` e um array
-- `modulos`. Com cobrança separada isso não fecha — a oficina pode ter
-- o Vextron em dia e o VexOS vencido no mesmo dia. As colunas antigas
-- continuam na tabela: o app desktop instalado ainda as lê, e derrubar
-- isso agora quebraria a base. A seção 6 mantém as duas em dia.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Planos
--
-- Tabela em vez de constante no código: mudar preço não pode exigir
-- deploy, e o histórico de quanto custava fica no banco.
--
-- PREENCHER os preços antes de usar em produção.
-- ---------------------------------------------------------------------
create table if not exists planos (
    codigo      text primary key,          -- 'vextron', 'vexos', 'combo'
    nome        text not null,
    descricao   text,
    preco       numeric(12,2) not null,

    -- O que este plano libera. É aqui que o combo se resolve.
    modulos     text[] not null,

    -- Quantos dias cada pagamento aprovado acrescenta. 30 e não "1 mês"
    -- porque mês tem tamanho variável e a conta em dias não tem
    -- ambiguidade na virada de fevereiro.
    dias        integer not null default 30,

    -- Id do plano de assinatura no Mercado Pago, se você criar
    -- preapproval_plan pelo painel. Nulo = preapproval avulso.
    mp_plan_id  text,

    ordem       integer not null default 0,   -- ordem na vitrine
    ativo       boolean not null default true,
    criado_em   timestamptz not null default now()
);

insert into planos (codigo, nome, descricao, preco, modulos, dias, ordem) values
    ('vextron', 'Motronix Vextron',
     'Identificação e comparação de arquivos de ECU, biblioteca e diagnóstico OBD-II.',
     0, array['vextron'], 30, 1),
    ('vexos', 'VexOS',
     'Ordens de serviço, histórico por placa e ficha do cliente.',
     0, array['vexos'], 30, 2),
    ('combo', 'Vextron + VexOS',
     'Os dois sistemas integrados: a análise de ECU entra direto na ordem de serviço.',
     0, array['vextron', 'vexos'], 30, 3)
on conflict (codigo) do update
   set nome      = excluded.nome,
       descricao = excluded.descricao,
       modulos   = excluded.modulos,
       ordem     = excluded.ordem;
-- O do update acima NÃO toca em `preco`: reaplicar o script não pode
-- zerar preços que você já ajustou.


-- ---------------------------------------------------------------------
-- 2. Assinaturas — uma por oficina e MÓDULO
--
-- Por módulo, não por plano: é o módulo que decide o acesso, e assim o
-- combo simplesmente preenche duas linhas. Guardamos também qual plano
-- pagou, para a tela dizer "Combo" em vez de listar dois itens soltos.
--
-- `origem` distingue o cartão recorrente do PIX avulso: no recorrente o
-- Mercado Pago cobra sozinho todo mês; no PIX é o cliente que paga de
-- novo, e a tela precisa saber qual dos dois avisar quando faltam dias.
-- ---------------------------------------------------------------------
create table if not exists assinaturas (
    id          uuid primary key default gen_random_uuid(),
    oficina_id  uuid not null references oficinas(id) on delete cascade,
    modulo      text not null,
    plano       text references planos(codigo),

    origem      text not null default 'manual'
                check (origem in ('recorrente', 'pix', 'manual')),

    -- 'pendente'  criada, primeiro pagamento ainda não caiu
    -- 'ativa'     em dia
    -- 'vencida'   passou da validade sem novo pagamento
    -- 'cancelada' o cliente encerrou (ou você encerrou)
    status      text not null default 'pendente'
                check (status in ('pendente', 'ativa', 'vencida', 'cancelada')),

    validade    timestamptz,

    -- Assinatura recorrente no Mercado Pago. NÃO é único: no combo as
    -- duas linhas compartilham a mesma preapproval — é uma cobrança só.
    mp_preapproval_id text,

    criada_em     timestamptz not null default now(),
    atualizada_em timestamptz not null default now(),

    unique (oficina_id, modulo)
);

create index if not exists idx_assinaturas_preapproval
    on assinaturas (mp_preapproval_id) where mp_preapproval_id is not null;
create index if not exists idx_assinaturas_oficina
    on assinaturas (oficina_id, status);


-- ---------------------------------------------------------------------
-- 3. Pagamentos — o razão, e a trava contra mês grátis
--
-- O Mercado Pago REENVIA a mesma notificação quando não recebe 200 na
-- primeira: rede lenta, cold start da função, deploy no meio. Sem
-- proteção, a mesma cobrança de R$ 100 estenderia a validade duas,
-- três vezes.
--
-- `mp_id` é único. É ele que faz a segunda notificação virar um no-op
-- silencioso, em vez de um mês grátis.
-- ---------------------------------------------------------------------
create table if not exists pagamentos (
    id          uuid primary key default gen_random_uuid(),
    oficina_id  uuid references oficinas(id) on delete set null,
    plano       text references planos(codigo),

    mp_id       text not null unique,      -- id do payment no Mercado Pago
    tipo        text not null default 'pix'
                check (tipo in ('recorrente', 'pix')),

    valor       numeric(12,2),
    status      text,                      -- approved, rejected, pending...
    dias        integer,                   -- quantos dias este pagamento deu

    -- Resposta crua da API, para conferência quando o cliente reclamar.
    -- Guardar o que o Mercado Pago disse evita discussão sobre o que
    -- "deveria" ter acontecido.
    bruto       jsonb,

    recebido_em timestamptz not null default now()
);

create index if not exists idx_pagamentos_oficina
    on pagamentos (oficina_id, recebido_em desc);


-- ---------------------------------------------------------------------
-- 4. Aplicar um pagamento — tudo numa operação só
--
-- Inserir o pagamento e estender a validade em chamadas separadas abre
-- uma janela: se a segunda falhar, o cliente pagou e não recebeu. E se
-- a notificação chegar duplicada entre as duas, estende duas vezes.
--
-- Aqui o insert em `pagamentos` é o guarda: se o mp_id já existe, o
-- ON CONFLICT não insere nada, a função devolve false e nada se mexe.
-- Idempotente por construção, não por checagem prévia — que teria
-- janela de corrida entre o SELECT e o UPDATE.
--
-- A validade nova parte do MAIOR entre agora e a validade atual: quem
-- paga adiantado não perde os dias que já tinha, e quem paga atrasado
-- não ganha os dias em que ficou sem usar.
-- ---------------------------------------------------------------------
create or replace function aplicar_pagamento(
    p_mp_id       text,
    p_oficina_id  uuid,
    p_plano       text,
    p_tipo        text,
    p_valor       numeric,
    p_status      text,
    p_preapproval text default null,
    p_bruto       jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_dias    integer;
    v_modulos text[];
    v_novo    integer := 0;
    v_mod     text;
begin
    select dias, modulos into v_dias, v_modulos
      from planos where codigo = p_plano;
    if v_dias is null then
        raise exception 'Plano % não existe.', p_plano;
    end if;

    insert into pagamentos (oficina_id, plano, mp_id, tipo, valor,
                            status, dias, bruto)
    values (p_oficina_id, p_plano, p_mp_id, p_tipo, p_valor,
            p_status, v_dias, p_bruto)
    on conflict (mp_id) do nothing;

    get diagnostics v_novo = row_count;
    if v_novo = 0 then
        return false;             -- notificação repetida: nada a fazer
    end if;

    -- Só pagamento aprovado estende. O recusado fica gravado assim
    -- mesmo — é o que explica ao cliente por que não renovou.
    if p_status is distinct from 'approved' then
        return true;
    end if;

    -- Um pagamento do combo passa duas vezes por aqui, uma por módulo.
    foreach v_mod in array v_modulos loop
        insert into assinaturas (oficina_id, modulo, plano, origem,
                                 status, validade, mp_preapproval_id)
        values (p_oficina_id, v_mod, p_plano,
                case when p_tipo = 'recorrente' then 'recorrente' else 'pix' end,
                'ativa', now() + (v_dias || ' days')::interval, p_preapproval)
        on conflict (oficina_id, modulo) do update
           set status   = 'ativa',
               plano    = excluded.plano,
               origem   = excluded.origem,
               validade = greatest(coalesce(assinaturas.validade, now()), now())
                          + (v_dias || ' days')::interval,
               mp_preapproval_id = coalesce(excluded.mp_preapproval_id,
                                            assinaturas.mp_preapproval_id),
               atualizada_em = now();
    end loop;

    return true;
end;
$$;

revoke execute on function aplicar_pagamento(text, uuid, text, text,
                                             numeric, text, text, jsonb)
    from public;
-- Sem grant para `authenticated`: só a service key (o webhook) chama.


-- ---------------------------------------------------------------------
-- 5. tem_modulo() — agora olha a assinatura do módulo
--
-- Antes conferia `oficinas.validade`, uma só para tudo. Agora cada
-- módulo tem a sua, venha ela de um plano avulso ou do combo. A
-- verificação de `status` da oficina continua: oficina cancelada não
-- acessa nada, mesmo com módulo pago.
-- ---------------------------------------------------------------------
create or replace function tem_modulo(p_modulo text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists(
        select 1
          from assinaturas a
          join oficinas o on o.id = a.oficina_id
         where a.oficina_id = minha_oficina()
           and a.modulo = p_modulo
           and a.status = 'ativa'
           and a.validade > now()
           and o.status <> 'cancelada'
    );
$$;


-- ---------------------------------------------------------------------
-- 6. Espelho para o app desktop
--
-- O Vextron instalado lê `oficinas.modulos` e `oficinas.validade`. Em
-- vez de atualizar o app de todo mundo agora, um gatilho mantém as duas
-- colunas em dia a partir das assinaturas.
-- ---------------------------------------------------------------------
create or replace function espelhar_assinaturas()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_of uuid := coalesce(new.oficina_id, old.oficina_id);
begin
    update oficinas o
       set modulos = coalesce((
               select array_agg(a.modulo order by a.modulo)
                 from assinaturas a
                where a.oficina_id = v_of
                  and a.status = 'ativa'
                  and a.validade > now()
           ), '{}'),
           validade = coalesce((
               select max(a.validade)
                 from assinaturas a
                where a.oficina_id = v_of
                  and a.status = 'ativa'
           ), o.validade),
           atualizada_em = now()
     where o.id = v_of;
    return null;
end;
$$;

drop trigger if exists trg_espelhar_assinaturas on assinaturas;
create trigger trg_espelhar_assinaturas
    after insert or update or delete on assinaturas
    for each row execute function espelhar_assinaturas();


-- ---------------------------------------------------------------------
-- 7. Migrar o que já existe
--
-- Transforma o modelo antigo (array `modulos` + `validade` da oficina)
-- em linhas de assinatura, com origem 'manual'. Sem isto, o passo 5
-- derruba o acesso de todo mundo que já usa o sistema no momento em
-- que este script rodar.
--
-- Quem já tinha os dois módulos entra como 'combo': é o que ele de fato
-- tem, e a tela vai mostrar certo.
-- ---------------------------------------------------------------------
insert into assinaturas (oficina_id, modulo, plano, origem, status, validade)
select o.id, m,
       case when cardinality(o.modulos) > 1 then 'combo' else m end,
       'manual',
       case when o.status = 'cancelada' then 'cancelada'
            when o.validade > now()     then 'ativa'
            else 'vencida' end,
       o.validade
  from oficinas o
  cross join unnest(o.modulos) as m
 where m in ('vextron', 'vexos')
on conflict (oficina_id, modulo) do nothing;

-- Base antiga, anterior ao campo `modulos`: quem paga o Vextron mas tem
-- o array vazio entra com o Vextron pela validade da oficina.
insert into assinaturas (oficina_id, modulo, plano, origem, status, validade)
select o.id, 'vextron', 'vextron', 'manual',
       case when o.status = 'cancelada' then 'cancelada'
            when o.validade > now()     then 'ativa'
            else 'vencida' end,
       o.validade
  from oficinas o
 where cardinality(o.modulos) = 0
on conflict (oficina_id, modulo) do nothing;


-- ---------------------------------------------------------------------
-- 8. Qual plano a oficina tem hoje
--
-- A tela de assinatura precisa disso para não vender de novo o que já
-- está pago: quem está no combo não pode ver o botão de assinar o VexOS
-- avulso, senão paga duas vezes pela mesma coisa.
-- ---------------------------------------------------------------------
create or replace view minha_assinatura
with (security_invoker = true) as
select a.oficina_id,
       a.modulo,
       a.plano,
       a.origem,
       a.status,
       a.validade,
       a.mp_preapproval_id,
       greatest(0, ceil(extract(epoch from (a.validade - now())) / 86400))::int
           as dias_restantes,
       p.nome  as plano_nome,
       p.preco as plano_preco
  from assinaturas a
  left join planos p on p.codigo = a.plano;
-- security_invoker: sem isto a view roda como dona e devolve a
-- assinatura de TODAS as oficinas para qualquer usuário autenticado.


-- ---------------------------------------------------------------------
-- 9. Permissões
--
-- O cliente LÊ a própria assinatura (a tela mostra vencimento e
-- histórico) e não escreve nada: quem grava é o webhook, com a service
-- key. Sem o revoke, o Supabase deixaria o dono da oficina dar PATCH na
-- própria validade pelo console do navegador.
-- ---------------------------------------------------------------------
alter table assinaturas enable row level security;
alter table pagamentos  enable row level security;
alter table planos      enable row level security;

revoke insert, update, delete on assinaturas from authenticated, anon;
revoke insert, update, delete on pagamentos  from authenticated, anon;
revoke insert, update, delete on planos      from authenticated, anon;

drop policy if exists "le assinaturas" on assinaturas;
create policy "le assinaturas" on assinaturas
    for select using (oficina_id = minha_oficina());

drop policy if exists "le pagamentos" on pagamentos;
create policy "le pagamentos" on pagamentos
    for select using (oficina_id = minha_oficina());

-- Planos e preços são públicos: a vitrine precisa mostrá-los antes de a
-- pessoa ter conta.
drop policy if exists "le planos" on planos;
create policy "le planos" on planos
    for select using (ativo);

grant select on planos to anon, authenticated;
grant select on minha_assinatura to authenticated;


-- ---------------------------------------------------------------------
-- 10. Conferência
--
-- Rode depois de aplicar. Nenhuma oficina que estava ativa pode ter
-- perdido o acesso na migração.
-- ---------------------------------------------------------------------
-- select o.nome, o.status, o.validade as validade_antiga, o.modulos,
--        a.modulo, a.plano, a.status as assinatura, a.validade as vence
--   from oficinas o
--   left join assinaturas a on a.oficina_id = o.id
--  order by o.nome, a.modulo;

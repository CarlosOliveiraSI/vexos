-- =====================================================================
-- VexOS — Correção: pagamento PIX aprovado não estendia a validade
--
-- Rodar no SQL Editor do Supabase, DEPOIS do 04_assinaturas.sql.
--
-- O BUG
--
-- Um pagamento PIX gera DUAS notificações com o MESMO id:
--
--     1ª  status "pending"   — QR gerado, ninguém pagou ainda
--     2ª  status "approved"  — o dinheiro caiu
--
-- A versão anterior usava `on conflict (mp_id) do nothing` como trava
-- de idempotência. Isso registrava a 1ª notificação e BLOQUEAVA a 2ª —
-- exatamente a que deveria liberar o acesso. O cliente pagava, o log
-- dizia "repetido", e a validade nunca se mexia.
--
-- A causa raiz: `mp_id` identifica um PAGAMENTO, que muda de estado ao
-- longo da vida. Não identifica um EVENTO. Tratar um como o outro faz
-- a trava barrar a aprovação junto com a duplicata.
--
-- A CORREÇÃO
--
-- Duas perguntas diferentes, guardadas em lugares diferentes:
--
--     "já registrei este pagamento?"  -> chave única mp_id
--     "já CREDITEI este pagamento?"   -> coluna aplicado_em
--
-- A linha é atualizada livremente quando o status muda. O crédito
-- acontece uma vez só, garantido por um UPDATE condicional que só
-- pega a linha se `aplicado_em` ainda for nulo. Dois webhooks
-- simultâneos com "approved": um ganha a corrida, o outro não
-- encontra linha para atualizar e não credita.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Marca de crédito
-- ---------------------------------------------------------------------
alter table pagamentos
    add column if not exists aplicado_em timestamptz;

comment on column pagamentos.aplicado_em is
    'Quando este pagamento estendeu a assinatura. Nulo = registrado mas ainda não creditado. É a trava real contra crédito em dobro.';

-- Pagamentos que JÁ estenderam a validade antes desta correção ficam
-- marcados, para o reprocessamento do item 4 não creditar duas vezes.
update pagamentos
   set aplicado_em = recebido_em
 where status = 'approved'
   and aplicado_em is null
   and exists (
       select 1 from assinaturas a
        where a.oficina_id = pagamentos.oficina_id
          and a.status = 'ativa'
          and a.origem in ('pix', 'recorrente')
   );


-- ---------------------------------------------------------------------
-- 2. aplicar_pagamento() — nova lógica
--
-- Retorno:
--   true   creditou agora (estendeu a validade)
--   false  nada a fazer — repetida, ou ainda não aprovada
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
    v_mod     text;
    v_claim   integer := 0;
begin
    select dias, modulos into v_dias, v_modulos
      from planos where codigo = p_plano;
    if v_dias is null then
        raise exception 'Plano % não existe.', p_plano;
    end if;

    -- Registra ou ATUALIZA. Diferente da versão anterior: a mudança de
    -- pending para approved precisa passar, é ela que carrega a
    -- informação de que o dinheiro caiu.
    insert into pagamentos (oficina_id, plano, mp_id, tipo, valor,
                            status, dias, bruto)
    values (p_oficina_id, p_plano, p_mp_id, p_tipo, p_valor,
            p_status, v_dias, p_bruto)
    on conflict (mp_id) do update
       set status = excluded.status,
           valor  = coalesce(excluded.valor, pagamentos.valor),
           bruto  = coalesce(excluded.bruto, pagamentos.bruto);

    if p_status is distinct from 'approved' then
        return false;             -- registrado; crédito só quando aprovar
    end if;

    -- A trava. Só uma execução consegue marcar `aplicado_em`; qualquer
    -- outra encontra a coluna preenchida e sai sem creditar. Como é um
    -- UPDATE condicional, a checagem e a marcação acontecem no mesmo
    -- comando — não há janela entre "verificar" e "gravar".
    update pagamentos
       set aplicado_em = now()
     where mp_id = p_mp_id
       and aplicado_em is null;

    get diagnostics v_claim = row_count;
    if v_claim = 0 then
        return false;             -- já creditado antes
    end if;

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


-- ---------------------------------------------------------------------
-- 3. Conferência
-- ---------------------------------------------------------------------
-- select mp_id, plano, tipo, valor, status, aplicado_em, recebido_em
--   from pagamentos
--  order by recebido_em desc;


-- ---------------------------------------------------------------------
-- 4. Recuperar o pagamento que ficou preso
--
-- Depois de rodar este script, volte ao painel do Mercado Pago, em
-- Webhooks, e use REENVIAR na notificação daquele pagamento aprovado.
-- Agora a transição pending -> approved passa, e o crédito acontece.
--
-- Se preferir não depender do reenvio, dá para creditar na mão: troque
-- o id abaixo pelo do pagamento aprovado e rode. O `aplicado_em is null`
-- garante que rodar duas vezes não credita duas vezes.
-- ---------------------------------------------------------------------
-- do $$
-- declare
--     p record;
-- begin
--     select * into p from pagamentos
--      where mp_id = 'COLE_O_ID_AQUI' and aplicado_em is null;
--     if p.mp_id is null then
--         raise notice 'Pagamento não encontrado ou já creditado.';
--         return;
--     end if;
--     perform aplicar_pagamento(p.mp_id, p.oficina_id, p.plano, p.tipo,
--                               p.valor, 'approved', null, p.bruto);
-- end $$;

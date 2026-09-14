-- =====================================================================
-- VexOS — 08_financeiro_margem.sql
-- Margem por ordem, compras por mês e valor imobilizado em estoque.
--
-- O ponto central é o congelamento do custo: sem ele, a margem histórica
-- muda sozinha toda vez que uma peça entra por um preço diferente.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Confere o terreno
-- ---------------------------------------------------------------------
do $verifica$
declare
  faltando text[] := '{}';
  achou boolean;
  par text[];
  esperado text[][] := array[
    ['os_itens','peca_id'], ['os_itens','baixa_em'], ['os_itens','valor_unit'],
    ['ordens_servico','concluida_em'], ['ordens_servico','status'],
    ['compras','status'], ['compras','emitida_em'],
    ['compra_itens','quantidade'], ['compra_itens','custo_unit'],
    ['pecas','preco_custo'], ['pecas','saldo']
  ];
begin
  foreach par slice 1 in array esperado loop
    execute 'select exists (select 1 from information_schema.columns
              where table_schema=''public'' and table_name=$1 and column_name=$2)'
      into achou using par[1], par[2];
    if not achou then faltando := faltando || format('%s.%s', par[1], par[2]); end if;
  end loop;

  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='os_mover_peca') then
    faltando := faltando || 'função os_mover_peca() — aplique antes a 07_os_estoque.sql';
  end if;

  if array_length(faltando,1) > 0 then
    raise exception E'Não apliquei. Faltam no schema:\n  - %',
      array_to_string(faltando, E'\n  - ');
  end if;
  raise notice 'Schema conferido. Aplicando.';
end
$verifica$;

-- ---------------------------------------------------------------------
-- 1. Custo congelado no item da ordem
--
-- Sem esta coluna, a margem sai de pecas.preco_custo, que é o custo de
-- HOJE. Uma nota nova entra e a margem de uma ordem fechada em março
-- muda sozinha. Aqui o custo do momento da baixa fica gravado na linha
-- e não se mexe mais — do mesmo jeito que valor_unit já guarda o preço
-- praticado naquela venda.
-- ---------------------------------------------------------------------
alter table public.os_itens
  add column if not exists custo_unit numeric(14,4);

-- ---------------------------------------------------------------------
-- 2. os_mover_peca passa a gravar o custo na baixa
--    (mesma função da 07, com duas linhas a mais)
-- ---------------------------------------------------------------------
create or replace function public.os_mover_peca(
  p_item_id uuid,
  p_devolver boolean default false
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item   record;
  v_os     record;
  v_saldo  numeric;
  v_custo  numeric;
  v_novo   numeric;
  v_motivo text;
begin
  select * into v_item from public.os_itens where id = p_item_id;
  if not found or v_item.peca_id is null then return; end if;

  if p_devolver and v_item.baixa_em is null then return; end if;
  if not p_devolver and v_item.baixa_em is not null then return; end if;

  select numero into v_os from public.ordens_servico where id = v_item.os_id;

  select coalesce(saldo, 0), coalesce(preco_custo, 0)
    into v_saldo, v_custo
    from public.pecas
   where id = v_item.peca_id
     for update;

  if p_devolver then
    v_novo := v_saldo + v_item.quantidade;
    v_motivo := format('Estorno da OS %s', coalesce(v_os.numero::text, '?'));
  else
    v_novo := v_saldo - v_item.quantidade;
    v_motivo := format('Saída para a OS %s', coalesce(v_os.numero::text, '?'));
  end if;

  perform public.ajustar_estoque(v_item.peca_id, v_novo, v_motivo);

  update public.os_itens
     set baixa_em   = case when p_devolver then null else now() end,
         -- na baixa congela; no estorno solta, para a próxima baixa
         -- pegar o custo vigente naquele momento
         custo_unit = case when p_devolver then null else v_custo end
   where id = p_item_id;
end $$;

-- ---------------------------------------------------------------------
-- 3. Margem por ordem — agora com o custo congelado
-- ---------------------------------------------------------------------
create or replace view public.os_margem
with (security_invoker = true) as
select
  o.id,
  o.oficina_id,
  o.numero,
  o.status,
  o.concluida_em,
  coalesce(sum(i.quantidade * coalesce(i.valor_unit, 0)), 0) as faturado,
  -- custo_unit quando existe; preco_custo só como reserva, para ordens
  -- concluídas antes desta migration
  coalesce(sum(case when i.peca_id is not null
                    then i.quantidade * coalesce(i.custo_unit, p.preco_custo, 0)
                    else 0 end), 0)                          as custo_pecas,
  coalesce(sum(case when i.peca_id is not null
                    then i.quantidade * coalesce(i.valor_unit, 0)
                    else 0 end), 0)                          as faturado_pecas,
  count(i.id) filter (where i.peca_id is not null)            as qtd_pecas
from public.ordens_servico o
left join public.os_itens i on i.os_id = o.id
left join public.pecas    p on p.id = i.peca_id
group by o.id;

-- ---------------------------------------------------------------------
-- 4. Mês a mês: faturado, custo das peças e compras
--
-- Mesmo formato de financeiro_mensal, para a tela consumir do mesmo
-- jeito. Compras entram pela data de emissão da nota, que é quando o
-- dinheiro efetivamente saiu.
-- ---------------------------------------------------------------------
create or replace function public.financeiro_margem_mensal(p_meses int default 6)
returns table (
  mes          date,
  faturado     numeric,
  custo_pecas  numeric,
  margem       numeric,
  ordens       bigint,
  compras      numeric,
  notas        bigint
)
language sql
security invoker
stable
set search_path = public
as $$
  with meses as (
    select generate_series(
             date_trunc('month', current_date) - ((p_meses - 1) || ' months')::interval,
             date_trunc('month', current_date),
             '1 month'
           )::date as mes
  ),
  vendas as (
    select date_trunc('month', m.concluida_em)::date as mes,
           sum(m.faturado)    as faturado,
           sum(m.custo_pecas) as custo_pecas,
           count(*)           as ordens
      from public.os_margem m
     where m.status = 'concluida'
       and m.concluida_em is not null
     group by 1
  ),
  entradas as (
    select date_trunc('month', coalesce(c.emitida_em, c.criada_em::date))::date as mes,
           sum(i.quantidade * i.custo_unit) as compras,
           count(distinct c.id)             as notas
      from public.compras c
      join public.compra_itens i on i.compra_id = c.id
     where c.status = 'lancada'
     group by 1
  )
  select
    ms.mes,
    coalesce(v.faturado, 0)                                as faturado,
    coalesce(v.custo_pecas, 0)                             as custo_pecas,
    coalesce(v.faturado, 0) - coalesce(v.custo_pecas, 0)   as margem,
    coalesce(v.ordens, 0)                                  as ordens,
    coalesce(e.compras, 0)                                 as compras,
    coalesce(e.notas, 0)                                   as notas
  from meses ms
  left join vendas   v on v.mes = ms.mes
  left join entradas e on e.mes = ms.mes
  order by ms.mes;
$$;

-- ---------------------------------------------------------------------
-- 5. Quanto está parado na prateleira
--
-- Saldo negativo entra como zero: negativo é erro de lançamento a
-- acertar na contagem, não dinheiro a descontar do estoque.
-- ---------------------------------------------------------------------
create or replace function public.estoque_resumo()
returns table (
  valor_custo numeric,
  itens       bigint,
  sem_custo   bigint,
  negativos   bigint
)
language sql
security invoker
stable
set search_path = public
as $$
  select
    coalesce(sum(greatest(coalesce(saldo,0), 0) * coalesce(preco_custo,0)), 0),
    count(*) filter (where coalesce(saldo,0) > 0),
    count(*) filter (where coalesce(saldo,0) > 0 and coalesce(preco_custo,0) = 0),
    count(*) filter (where coalesce(saldo,0) < 0)
  from public.pecas
  where ativo is true;
$$;

commit;

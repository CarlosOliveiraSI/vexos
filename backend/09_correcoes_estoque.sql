-- =====================================================================
-- VexOS — 09_correcoes_estoque.sql
--
-- Três correções, todas descobertas ao ler o schema do estoque:
--
--   1. lancar_compra não validava a oficina. Sendo SECURITY DEFINER,
--      bastava conhecer o id de uma compra alheia para lançá-la.
--   2. lancar_compra escolhia um custo arbitrário quando a mesma peça
--      aparecia em duas linhas da nota.
--   3. A baixa da OS gravava tipo 'ajuste' e deixava os_id nulo, porque
--      eu não sabia que estoque_mov já tinha as colunas os_id e
--      os_item_id prontas para isso — nem o índice único idx_mov_os_item,
--      que define uma movimentação por item de ordem.
-- =====================================================================

begin;

do $verifica$
declare faltando text[] := '{}';
begin
  if to_regclass('public.estoque_mov') is null then
    faltando := faltando || 'tabela estoque_mov';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='estoque_mov'
                    and column_name='os_item_id') then
    faltando := faltando || 'coluna estoque_mov.os_item_id';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='os_mover_peca') then
    faltando := faltando || 'função os_mover_peca() — aplique antes a 07_os_estoque.sql';
  end if;
  if array_length(faltando,1) > 0 then
    raise exception E'Não apliquei. Faltam:\n  - %', array_to_string(faltando, E'\n  - ');
  end if;
  raise notice 'Schema conferido. Aplicando.';
end
$verifica$;

-- ---------------------------------------------------------------------
-- 1 e 2. lancar_compra
--
-- Mantida igual à original, exceto pela checagem de oficina e pelo
-- cálculo do custo. O comentário sobre usar o custo da última compra em
-- vez de média ponderada continua valendo — a mudança aqui é só tornar
-- o resultado determinístico quando a peça se repete na nota.
-- ---------------------------------------------------------------------
create or replace function public.lancar_compra(p_compra_id uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    v_of   uuid;
    v_st   text;
    v_qtd  integer := 0;
begin
    select oficina_id, status into v_of, v_st
      from compras where id = p_compra_id;
    if v_of is null then
        raise exception 'Nota não encontrada.';
    end if;
    -- roda como dona e ignora RLS: sem esta linha, quem souber o id de
    -- uma compra de outra oficina consegue lançá-la
    if v_of <> minha_oficina() then
        raise exception 'Nota de outra oficina.';
    end if;
    if v_st <> 'rascunho' then
        return 0;                      -- já lançada ou cancelada
    end if;

    insert into estoque_mov (oficina_id, peca_id, tipo, quantidade,
                             custo_unit, compra_id, motivo, usuario_id)
    select v_of, ci.peca_id, 'entrada', ci.quantidade, ci.custo_unit,
           p_compra_id, 'Nota de compra', auth.uid()
      from compra_itens ci
     where ci.compra_id = p_compra_id;

    get diagnostics v_qtd = row_count;

    -- O custo da peça passa a ser o desta compra. Quando a mesma peça
    -- aparece em mais de uma linha da nota (fornecedor que quebra o
    -- item em duas), usa a média ponderada pela quantidade: o UPDATE
    -- ... FROM direto escolhia uma das linhas sem critério, e o
    -- resultado mudava de uma execução para outra.
    update pecas p
       set preco_custo   = m.custo,
           atualizada_em = now()
      from (
        select ci.peca_id,
               sum(ci.quantidade * ci.custo_unit)
                 / nullif(sum(ci.quantidade), 0) as custo
          from compra_itens ci
         where ci.compra_id = p_compra_id
           and ci.custo_unit is not null
           and ci.quantidade > 0
         group by ci.peca_id
      ) m
     where p.id = m.peca_id
       and m.custo is not null;

    update compras
       set status = 'lancada', lancada_em = now()
     where id = p_compra_id;

    return v_qtd;
end;
$function$;

-- ---------------------------------------------------------------------
-- 3. Baixa da OS gravando no razão como saída
--
-- A versão da 07 chamava ajustar_estoque, que registra tipo 'ajuste'.
-- O saldo saía certo, mas no razão toda peça usada em serviço aparecia
-- como acerto de inventário, e os_id ficava nulo — não dava para
-- consultar as movimentações de uma ordem a não ser pelo texto do
-- motivo.
--
-- SECURITY DEFINER porque estoque_mov não tem policy de INSERT: o
-- razão só é escrito por função. A oficina é conferida aqui dentro,
-- como ajustar_estoque faz.
-- ---------------------------------------------------------------------
create or replace function public.os_mover_peca(
  p_item_id uuid,
  p_devolver boolean default false
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item  record;
  v_os    record;
  v_of    uuid;
  v_custo numeric;
begin
  select * into v_item from public.os_itens where id = p_item_id;
  if not found or v_item.peca_id is null then return; end if;

  -- já está no estado pedido
  if p_devolver and v_item.baixa_em is null then return; end if;
  if not p_devolver and v_item.baixa_em is not null then return; end if;

  select o.numero, o.oficina_id into v_os
    from public.ordens_servico o where o.id = v_item.os_id;

  select p.oficina_id, coalesce(p.preco_custo, 0)
    into v_of, v_custo
    from public.pecas p where p.id = v_item.peca_id;

  if v_of is null then
    raise exception 'Peça não encontrada.';
  end if;
  if v_of <> minha_oficina() then
    raise exception 'Peça de outra oficina.';
  end if;
  if v_os.oficina_id is not null and v_os.oficina_id <> v_of then
    raise exception 'Ordem e peça são de oficinas diferentes.';
  end if;

  if p_devolver then
    -- Apaga o movimento em vez de lançar um contrário. Quem desenhou o
    -- estoque criou idx_mov_os_item, um índice único sobre os_item_id:
    -- cada item de OS tem no máximo uma linha no razão. O gatilho
    -- trg_saldo recalcula o saldo somando o razão, então a remoção
    -- devolve a peça sozinha. Ordem reaberta é saída que não aconteceu.
    delete from estoque_mov
     where os_item_id = v_item.id and tipo = 'saida';
  else
    insert into estoque_mov (oficina_id, peca_id, tipo, quantidade, sentido,
                             custo_unit, os_id, os_item_id, motivo, usuario_id)
    values (v_of, v_item.peca_id, 'saida', v_item.quantidade, -1,
            v_custo, v_item.os_id, v_item.id,
            format('Saída para a OS %s', coalesce(v_os.numero::text, '?')),
            auth.uid());
  end if;

  update public.os_itens
     set baixa_em   = case when p_devolver then null else now() end,
         custo_unit = case when p_devolver then null else v_custo end
   where id = p_item_id;
end $$;

-- ---------------------------------------------------------------------
-- 4. Movimentações de uma ordem, agora consultáveis por chave
-- ---------------------------------------------------------------------
create or replace view public.os_movimentacoes
with (security_invoker = true) as
select
  m.os_id,
  m.os_item_id,
  m.oficina_id,
  o.numero      as os_numero,
  p.numero      as peca_numero,
  p.nome        as peca,
  m.tipo,
  m.quantidade,
  m.custo_unit,
  m.quantidade * coalesce(m.custo_unit, 0) as total,
  m.motivo,
  m.criada_em
from public.estoque_mov m
join public.pecas p on p.id = m.peca_id
left join public.ordens_servico o on o.id = m.os_id
where m.os_id is not null;

commit;

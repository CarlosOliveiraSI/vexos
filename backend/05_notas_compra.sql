-- =====================================================================
-- VexOS — Notas de compra (entrada de estoque via XML da NFe, PDF ou manual)
-- Arquivo sugerido: backend/05_notas_compra.sql
-- =====================================================================
--
-- >>> AJUSTE ANTES DE RODAR — suposições sobre o schema atual do estoque:
--
--   public.oficina_atual()      função que devolve a oficina do usuário logado
--   public.pecas                id, oficina_id, codigo, nome, unidade,
--                               saldo, custo_medio, codigo_barras
--   public.estoque_movimentos   id, oficina_id, peca_id, tipo, quantidade,
--                               custo_unitario, origem, origem_id, criado_em
--
-- Se os nomes forem outros, os pontos a trocar estão marcados com "-- >>> AJUSTE".
-- Rode dentro de uma transação e confira antes de commitar.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Helper de tenant (só crie se ainda não existir no seu schema)
-- ---------------------------------------------------------------------
-- >>> AJUSTE: adapte à sua tabela de vínculo usuário → oficina.
--
-- create or replace function public.oficina_atual()
-- returns uuid
-- language sql stable security definer set search_path = public
-- as $$
--   select oficina_id from public.usuarios where id = auth.uid()
-- $$;

-- ---------------------------------------------------------------------
-- 1. Fornecedores
-- ---------------------------------------------------------------------
create table if not exists public.fornecedores (
  id            uuid primary key default gen_random_uuid(),
  oficina_id    uuid not null,
  cnpj          text,
  nome          text not null,
  nome_fantasia text,
  inscricao_est text,
  telefone      text,
  email         text,
  criado_em     timestamptz not null default now(),
  constraint fornecedores_cnpj_formato check (cnpj is null or cnpj ~ '^[0-9]{14}$')
);

create unique index if not exists fornecedores_oficina_cnpj_uk
  on public.fornecedores (oficina_id, cnpj) where cnpj is not null;

create index if not exists fornecedores_oficina_nome_ix
  on public.fornecedores (oficina_id, lower(nome));

-- ---------------------------------------------------------------------
-- 2. Notas de compra
-- ---------------------------------------------------------------------
do $$ begin
  create type public.nota_compra_status as enum ('rascunho', 'lancada', 'cancelada');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.nota_compra_origem as enum ('xml', 'pdf', 'manual');
exception when duplicate_object then null; end $$;

create table if not exists public.notas_compra (
  id             uuid primary key default gen_random_uuid(),
  oficina_id     uuid not null,
  fornecedor_id  uuid references public.fornecedores(id) on delete restrict,
  numero         text,
  serie          text,
  chave_acesso   char(44),
  emissao        date,
  observacoes    text,

  origem         public.nota_compra_origem not null default 'manual',
  status         public.nota_compra_status  not null default 'rascunho',

  -- totais conforme o documento de origem (para conferência)
  valor_produtos numeric(14,2) not null default 0,
  valor_frete    numeric(14,2) not null default 0,
  valor_seguro   numeric(14,2) not null default 0,
  valor_desconto numeric(14,2) not null default 0,
  valor_outros   numeric(14,2) not null default 0,
  valor_ipi      numeric(14,2) not null default 0,
  valor_st       numeric(14,2) not null default 0,
  valor_total    numeric(14,2) not null default 0,

  arquivo_path   text,   -- caminho no Storage (bucket notas-fiscais)
  arquivo_tipo   text,   -- 'xml' | 'pdf'

  criado_em      timestamptz not null default now(),
  criado_por     uuid default auth.uid(),
  lancada_em     timestamptz,
  lancada_por    uuid,

  constraint notas_compra_chave_formato
    check (chave_acesso is null or chave_acesso ~ '^[0-9]{44}$')
);

-- Idempotência: a mesma NFe não entra duas vezes na mesma oficina.
create unique index if not exists notas_compra_chave_uk
  on public.notas_compra (oficina_id, chave_acesso) where chave_acesso is not null;

-- Fallback para notas sem chave (PDF ruim, cupom, nota manual).
create unique index if not exists notas_compra_num_forn_uk
  on public.notas_compra (oficina_id, fornecedor_id, numero, serie)
  where chave_acesso is null and numero is not null and fornecedor_id is not null;

create index if not exists notas_compra_oficina_status_ix
  on public.notas_compra (oficina_id, status, emissao desc);

-- ---------------------------------------------------------------------
-- 3. Itens da nota
-- ---------------------------------------------------------------------
create table if not exists public.notas_compra_itens (
  id                uuid primary key default gen_random_uuid(),
  nota_id           uuid not null references public.notas_compra(id) on delete cascade,
  oficina_id        uuid not null,
  peca_id           uuid references public.pecas(id) on delete restrict,  -- >>> AJUSTE

  ordem             int  not null default 1,

  -- como veio no documento (preservado para auditoria e re-vínculo)
  codigo_fornecedor text,
  ean               text,
  descricao_origem  text not null,
  ncm               text,
  cfop              text,

  -- unidade comercial do fornecedor (CX, PC, DZ...) e conversão p/ sua unidade
  unidade_comercial text,
  fator_conversao   numeric(12,4) not null default 1 check (fator_conversao > 0),

  quantidade        numeric(14,4) not null check (quantidade > 0),
  valor_unitario    numeric(14,6) not null default 0,
  valor_produtos    numeric(14,2) not null default 0,
  valor_frete       numeric(14,2) not null default 0,
  valor_seguro      numeric(14,2) not null default 0,
  valor_desconto    numeric(14,2) not null default 0,
  valor_outros      numeric(14,2) not null default 0,
  valor_ipi         numeric(14,2) not null default 0,
  valor_st          numeric(14,2) not null default 0,

  -- quantidade que realmente entra no estoque e custo real por unidade
  quantidade_estoque numeric(14,4)
    generated always as (quantidade * fator_conversao) stored,
  custo_unitario    numeric(14,6) not null default 0,

  criado_em         timestamptz not null default now()
);

create index if not exists notas_compra_itens_nota_ix
  on public.notas_compra_itens (nota_id, ordem);

create index if not exists notas_compra_itens_peca_ix
  on public.notas_compra_itens (peca_id);

-- ---------------------------------------------------------------------
-- 4. De-para: código do fornecedor → peça do seu catálogo
--    Preenchido na primeira importação; nas seguintes o vínculo é automático.
-- ---------------------------------------------------------------------
create table if not exists public.fornecedor_peca_codigo (
  oficina_id        uuid not null,
  fornecedor_id     uuid not null references public.fornecedores(id) on delete cascade,
  codigo_fornecedor text not null,
  peca_id           uuid not null references public.pecas(id) on delete cascade,  -- >>> AJUSTE
  unidade_comercial text,
  fator_conversao   numeric(12,4) not null default 1 check (fator_conversao > 0),
  descricao_origem  text,
  atualizado_em     timestamptz not null default now(),
  primary key (fornecedor_id, codigo_fornecedor)
);

create index if not exists fornecedor_peca_codigo_peca_ix
  on public.fornecedor_peca_codigo (peca_id);

-- ---------------------------------------------------------------------
-- 5. Proteção: nota lançada não se edita
-- ---------------------------------------------------------------------
create or replace function public.nota_compra_bloqueia_edicao()
returns trigger language plpgsql as $$
begin
  if tg_table_name = 'notas_compra' then
    if old.status = 'lancada' and new.status = 'lancada' then
      raise exception 'Nota já lançada no estoque. Cancele a nota para alterá-la.';
    end if;
    return new;
  else
    if exists (select 1 from public.notas_compra n
               where n.id = coalesce(new.nota_id, old.nota_id)
                 and n.status = 'lancada') then
      raise exception 'Nota já lançada no estoque. Os itens não podem ser alterados.';
    end if;
    return coalesce(new, old);
  end if;
end $$;

drop trigger if exists trg_nota_compra_bloqueia on public.notas_compra;
create trigger trg_nota_compra_bloqueia
  before update on public.notas_compra
  for each row execute function public.nota_compra_bloqueia_edicao();

drop trigger if exists trg_nota_itens_bloqueia on public.notas_compra_itens;
create trigger trg_nota_itens_bloqueia
  before insert or update or delete on public.notas_compra_itens
  for each row execute function public.nota_compra_bloqueia_edicao();

-- ---------------------------------------------------------------------
-- 6. Lançamento no estoque (transacional, do lado do banco)
-- ---------------------------------------------------------------------
create or replace function public.lancar_nota_compra(p_nota uuid)
returns public.notas_compra
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_nota  public.notas_compra;
  v_item  record;
  v_saldo numeric;
  v_custo numeric;
begin
  select * into v_nota from public.notas_compra where id = p_nota for update;

  if not found then
    raise exception 'Nota não encontrada.';
  end if;
  if v_nota.status = 'lancada' then
    raise exception 'Esta nota já foi lançada no estoque.';
  end if;
  if v_nota.status = 'cancelada' then
    raise exception 'Nota cancelada não pode ser lançada.';
  end if;
  if not exists (select 1 from public.notas_compra_itens where nota_id = p_nota) then
    raise exception 'A nota não tem itens.';
  end if;
  if exists (select 1 from public.notas_compra_itens where nota_id = p_nota and peca_id is null) then
    raise exception 'Há itens sem peça vinculada. Vincule todos antes de lançar.';
  end if;

  for v_item in
    select * from public.notas_compra_itens where nota_id = p_nota order by ordem
  loop
    -- >>> AJUSTE: nomes de coluna de public.pecas
    select saldo, coalesce(custo_medio, 0)
      into v_saldo, v_custo
      from public.pecas
     where id = v_item.peca_id
       for update;

    -- custo médio ponderado; saldo zerado ou negativo assume o custo novo
    if v_saldo is null or v_saldo <= 0 then
      v_custo := v_item.custo_unitario;
    else
      v_custo := ((v_saldo * v_custo) + (v_item.quantidade_estoque * v_item.custo_unitario))
                 / (v_saldo + v_item.quantidade_estoque);
    end if;

    update public.pecas
       set saldo      = coalesce(saldo, 0) + v_item.quantidade_estoque,
           custo_medio = round(v_custo, 4)
     where id = v_item.peca_id;

    -- >>> AJUSTE: nomes de coluna de public.estoque_movimentos
    insert into public.estoque_movimentos
      (oficina_id, peca_id, tipo, quantidade, custo_unitario, origem, origem_id)
    values
      (v_nota.oficina_id, v_item.peca_id, 'entrada', v_item.quantidade_estoque,
       v_item.custo_unitario, 'nota_compra', v_nota.id);
  end loop;

  update public.notas_compra
     set status      = 'lancada',
         lancada_em  = now(),
         lancada_por = auth.uid()
   where id = p_nota
  returning * into v_nota;

  return v_nota;
end $$;

-- ---------------------------------------------------------------------
-- 7. Cancelamento (estorna o que entrou)
-- ---------------------------------------------------------------------
create or replace function public.cancelar_nota_compra(p_nota uuid)
returns public.notas_compra
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_nota public.notas_compra;
  v_item record;
begin
  select * into v_nota from public.notas_compra where id = p_nota for update;
  if not found then raise exception 'Nota não encontrada.'; end if;

  if v_nota.status = 'lancada' then
    for v_item in select * from public.notas_compra_itens where nota_id = p_nota loop
      update public.pecas
         set saldo = coalesce(saldo, 0) - v_item.quantidade_estoque
       where id = v_item.peca_id;

      insert into public.estoque_movimentos
        (oficina_id, peca_id, tipo, quantidade, custo_unitario, origem, origem_id)
      values
        (v_nota.oficina_id, v_item.peca_id, 'saida', v_item.quantidade_estoque,
         v_item.custo_unitario, 'nota_compra_cancelada', v_nota.id);
    end loop;
  end if;

  update public.notas_compra set status = 'cancelada' where id = p_nota
  returning * into v_nota;

  return v_nota;
end $$;

-- ---------------------------------------------------------------------
-- 8. RLS
-- ---------------------------------------------------------------------
alter table public.fornecedores           enable row level security;
alter table public.notas_compra           enable row level security;
alter table public.notas_compra_itens     enable row level security;
alter table public.fornecedor_peca_codigo enable row level security;

do $$
declare t text;
begin
  foreach t in array array['fornecedores','notas_compra','notas_compra_itens','fornecedor_peca_codigo']
  loop
    execute format('drop policy if exists %I_tenant on public.%I', t, t);
    execute format($f$
      create policy %I_tenant on public.%I
        for all to authenticated
        using      (oficina_id = public.oficina_atual())
        with check  (oficina_id = public.oficina_atual())
    $f$, t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 9. Storage: bucket privado para os arquivos originais
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('notas-fiscais', 'notas-fiscais', false)
on conflict (id) do nothing;

-- Caminho esperado: {oficina_id}/{nota_id}.{xml|pdf}
drop policy if exists notas_fiscais_tenant on storage.objects;
create policy notas_fiscais_tenant on storage.objects
  for all to authenticated
  using      (bucket_id = 'notas-fiscais'
              and (storage.foldername(name))[1] = public.oficina_atual()::text)
  with check (bucket_id = 'notas-fiscais'
              and (storage.foldername(name))[1] = public.oficina_atual()::text);

-- ---------------------------------------------------------------------
-- 10. View de conferência rápida (soma dos itens x total do documento)
-- ---------------------------------------------------------------------
create or replace view public.notas_compra_conferencia
with (security_invoker = true) as
select
  n.id,
  n.oficina_id,
  n.numero,
  n.serie,
  n.emissao,
  n.status,
  f.nome                                as fornecedor,
  n.valor_total                         as total_documento,
  coalesce(sum(i.custo_unitario * i.quantidade_estoque), 0) as total_itens,
  round(n.valor_total
        - coalesce(sum(i.custo_unitario * i.quantidade_estoque), 0), 2) as diferenca,
  count(i.id)                           as qtd_itens,
  count(i.id) filter (where i.peca_id is null) as itens_sem_vinculo
from public.notas_compra n
left join public.fornecedores f       on f.id = n.fornecedor_id
left join public.notas_compra_itens i on i.nota_id = n.id
group by n.id, f.nome;

commit;

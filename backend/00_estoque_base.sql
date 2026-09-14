-- =====================================================================
-- VexOS — 00_estoque_base.sql
--
-- Módulo de estoque: peças, notas de compra, itens, razão de
-- movimentação e o contador do número da peça.
--
-- Extraído do banco de produção em 13/09/2026, quando o módulo existia
-- apenas no painel do Supabase e não no repositório.
--
-- Como o estoque funciona, em uma frase: nada escreve em pecas.saldo
-- diretamente. Toda entrada e saída vira uma linha em estoque_mov, e o
-- gatilho trg_saldo recalcula o saldo da peça a partir dela.
--
-- Ordem: aplicar depois de 01_contas.sql e 02_vexos.sql (usa
-- minha_oficina, tem_modulo e ordens_servico) e antes de
-- 06_nota_importacao.sql, 07_os_estoque.sql e 08_financeiro_margem.sql.
--
-- Dentro de Constraints a ordem importa: chave primária e unique antes
-- das estrangeiras que as referenciam.
-- =====================================================================



-- ---------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------

create table if not exists public.compra_itens (
  id                     uuid default gen_random_uuid() not null,
  compra_id              uuid not null,
  peca_id                uuid not null,
  quantidade             numeric(12,3) not null,
  custo_unit             numeric(12,2),
  ordem                  integer default 0 not null
);

create table if not exists public.compras (
  id                     uuid default gen_random_uuid() not null,
  oficina_id             uuid not null,
  fornecedor             text,
  numero                 text,
  emitida_em             date,
  observacoes            text,
  status                 text default 'rascunho'::text not null,
  lancada_em             timestamp with time zone,
  criada_em              timestamp with time zone default now() not null,
  serie                  text,
  chave_acesso           char(44),
  fornecedor_cnpj        text,
  origem                 text default 'manual'::text not null,
  arquivo_path           text,
  valor_produtos         numeric(14,2),
  valor_frete            numeric(14,2),
  valor_desconto         numeric(14,2),
  valor_ipi              numeric(14,2),
  valor_st               numeric(14,2),
  valor_total            numeric(14,2)
);

create table if not exists public.contadores (
  oficina_id             uuid not null,
  pecas                  integer default 0 not null
);

create table if not exists public.estoque_mov (
  id                     uuid default gen_random_uuid() not null,
  oficina_id             uuid not null,
  peca_id                uuid not null,
  tipo                   text not null,
  quantidade             numeric(12,3) not null,
  sentido                smallint default 1 not null,
  custo_unit             numeric(12,2),
  os_id                  uuid,
  os_item_id             uuid,
  compra_id              uuid,
  motivo                 text,
  usuario_id             uuid,
  criada_em              timestamp with time zone default now() not null
);

create table if not exists public.pecas (
  id                     uuid default gen_random_uuid() not null,
  oficina_id             uuid not null,
  codigo                 text,
  nome                   text not null,
  marca                  text,
  aplicacao              text,
  unidade                text default 'un'::text not null,
  localizacao            text,
  preco_custo            numeric(12,2),
  preco_venda            numeric(12,2),
  saldo                  numeric(12,3) default 0 not null,
  minimo                 numeric(12,3),
  ativo                  boolean default true not null,
  criada_em              timestamp with time zone default now() not null,
  atualizada_em          timestamp with time zone default now() not null,
  numero                 integer
);


-- ---------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------

alter table public.compra_itens add constraint compra_itens_pkey PRIMARY KEY (id);

alter table public.compras add constraint compras_pkey PRIMARY KEY (id);

alter table public.contadores add constraint contadores_pkey PRIMARY KEY (oficina_id);

alter table public.estoque_mov add constraint estoque_mov_pkey PRIMARY KEY (id);

alter table public.pecas add constraint pecas_pkey PRIMARY KEY (id);

alter table public.compra_itens add constraint compra_itens_quantidade_check CHECK ((quantidade > (0)::numeric));

alter table public.compras add constraint compras_chave_formato CHECK (((chave_acesso IS NULL) OR (chave_acesso ~ '^[0-9]{44}$'::text)));

alter table public.compras add constraint compras_origem_valida CHECK ((origem = ANY (ARRAY['manual'::text, 'xml'::text, 'pdf'::text])));

alter table public.compras add constraint compras_status_check CHECK ((status = ANY (ARRAY['rascunho'::text, 'lancada'::text, 'cancelada'::text])));

alter table public.estoque_mov add constraint estoque_mov_quantidade_check CHECK ((quantidade > (0)::numeric));

alter table public.estoque_mov add constraint estoque_mov_sentido_check CHECK ((sentido = ANY (ARRAY['-1'::integer, 1])));

alter table public.estoque_mov add constraint estoque_mov_tipo_check CHECK ((tipo = ANY (ARRAY['entrada'::text, 'saida'::text, 'ajuste'::text])));

alter table public.compra_itens add constraint compra_itens_compra_id_fkey FOREIGN KEY (compra_id) REFERENCES compras(id) ON DELETE CASCADE;

alter table public.compra_itens add constraint compra_itens_peca_id_fkey FOREIGN KEY (peca_id) REFERENCES pecas(id) ON DELETE RESTRICT;

alter table public.compras add constraint compras_oficina_id_fkey FOREIGN KEY (oficina_id) REFERENCES oficinas(id) ON DELETE CASCADE;

alter table public.contadores add constraint contadores_oficina_id_fkey FOREIGN KEY (oficina_id) REFERENCES oficinas(id) ON DELETE CASCADE;

alter table public.estoque_mov add constraint estoque_mov_compra_id_fkey FOREIGN KEY (compra_id) REFERENCES compras(id) ON DELETE SET NULL;

alter table public.estoque_mov add constraint estoque_mov_oficina_id_fkey FOREIGN KEY (oficina_id) REFERENCES oficinas(id) ON DELETE CASCADE;

alter table public.estoque_mov add constraint estoque_mov_os_id_fkey FOREIGN KEY (os_id) REFERENCES ordens_servico(id) ON DELETE SET NULL;

alter table public.estoque_mov add constraint estoque_mov_os_item_id_fkey FOREIGN KEY (os_item_id) REFERENCES os_itens(id) ON DELETE SET NULL;

alter table public.estoque_mov add constraint estoque_mov_peca_id_fkey FOREIGN KEY (peca_id) REFERENCES pecas(id) ON DELETE CASCADE;

alter table public.estoque_mov add constraint estoque_mov_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES perfis(id) ON DELETE SET NULL;

alter table public.pecas add constraint pecas_oficina_id_fkey FOREIGN KEY (oficina_id) REFERENCES oficinas(id) ON DELETE CASCADE;


-- ---------------------------------------------------------------------
-- Índices
-- ---------------------------------------------------------------------

CREATE INDEX idx_compra_itens ON public.compra_itens USING btree (compra_id);

CREATE INDEX idx_compras_oficina ON public.compras USING btree (oficina_id, emitida_em DESC);

CREATE INDEX idx_mov_oficina ON public.estoque_mov USING btree (oficina_id, criada_em DESC);

CREATE INDEX idx_mov_peca ON public.estoque_mov USING btree (peca_id, criada_em DESC);

CREATE INDEX idx_pecas_nome ON public.pecas USING btree (oficina_id, lower(nome));

CREATE INDEX idx_pecas_oficina ON public.pecas USING btree (oficina_id, ativo);

CREATE UNIQUE INDEX compras_chave_uk ON public.compras USING btree (oficina_id, chave_acesso) WHERE (chave_acesso IS NOT NULL);

CREATE UNIQUE INDEX idx_mov_os_item ON public.estoque_mov USING btree (os_item_id) WHERE (os_item_id IS NOT NULL);

CREATE UNIQUE INDEX idx_pecas_codigo ON public.pecas USING btree (oficina_id, lower(codigo)) WHERE (codigo IS NOT NULL);

CREATE UNIQUE INDEX idx_pecas_numero ON public.pecas USING btree (oficina_id, numero);


-- ---------------------------------------------------------------------
-- Funções
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ajustar_estoque(p_peca_id uuid, p_novo_saldo numeric, p_motivo text DEFAULT NULL::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_of     uuid;
    v_atual  numeric;
    v_dif    numeric;
begin
    select oficina_id, saldo into v_of, v_atual
      from pecas where id = p_peca_id;

    if v_of is null then
        raise exception 'Peça não encontrada.';
    end if;
    -- Confere a oficina DENTRO da função: ela roda como dona e ignora
    -- RLS, então sem esta linha um usuário ajustaria o estoque de
    -- qualquer oficina só passando o id da peça.
    if v_of <> minha_oficina() then
        raise exception 'Peça de outra oficina.';
    end if;

    v_dif := p_novo_saldo - coalesce(v_atual, 0);
    if v_dif = 0 then
        return v_atual;               -- nada mudou, não suja o razão
    end if;

    insert into estoque_mov (oficina_id, peca_id, tipo, quantidade,
                             sentido, motivo, usuario_id)
    values (v_of, p_peca_id, 'ajuste', abs(v_dif),
            case when v_dif > 0 then 1 else -1 end,
            coalesce(nullif(trim(p_motivo), ''), 'Ajuste de inventário'),
            auth.uid());

    return p_novo_saldo;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.gerar_numero_peca()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_n integer;
begin
    if new.numero is not null then
        return new;
    end if;

    -- O UPDATE trava a linha da oficina até o fim da transação, então
    -- dois cadastros ao mesmo tempo saem com números diferentes.
    insert into contadores (oficina_id, pecas)
    values (new.oficina_id, 1)
    on conflict (oficina_id) do update
       set pecas = contadores.pecas + 1
    returning pecas into v_n;

    new.numero := v_n;
    return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.lancar_compra(p_compra_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    if v_st <> 'rascunho' then
        return 0;                      -- já lançada ou cancelada
    end if;

    insert into estoque_mov (oficina_id, peca_id, tipo, quantidade,
                             custo_unit, compra_id, motivo)
    select v_of, ci.peca_id, 'entrada', ci.quantidade, ci.custo_unit,
           p_compra_id, 'Nota de compra'
      from compra_itens ci
     where ci.compra_id = p_compra_id;

    get diagnostics v_qtd = row_count;

    -- O custo da peça passa a ser o da última compra. Média ponderada
    -- seria mais correta contabilmente, mas exige saldo e custo
    -- anteriores confiáveis — coisa que estoque novo não tem.
    update pecas p
       set preco_custo = ci.custo_unit,
           atualizada_em = now()
      from compra_itens ci
     where ci.compra_id = p_compra_id
       and p.id = ci.peca_id
       and ci.custo_unit is not null;

    update compras
       set status = 'lancada', lancada_em = now()
     where id = p_compra_id;

    return v_qtd;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.recalcular_saldo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_peca uuid := coalesce(new.peca_id, old.peca_id);
begin
    update pecas p
       set saldo = coalesce((
               select sum(case m.tipo
                            when 'entrada' then m.quantidade
                            when 'saida'   then -m.quantidade
                            else m.quantidade * m.sentido
                          end)
                 from estoque_mov m
                where m.peca_id = v_peca
           ), 0),
           atualizada_em = now()
     where p.id = v_peca;
    return null;
end;
$function$
;


-- ---------------------------------------------------------------------
-- Gatilhos
-- ---------------------------------------------------------------------

CREATE TRIGGER trg_numero_peca BEFORE INSERT ON public.pecas FOR EACH ROW EXECUTE FUNCTION gerar_numero_peca();

CREATE TRIGGER trg_saldo AFTER INSERT OR DELETE OR UPDATE ON public.estoque_mov FOR EACH ROW EXECUTE FUNCTION recalcular_saldo();


-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

alter table public.compra_itens enable row level security;

alter table public.compras enable row level security;

alter table public.contadores enable row level security;

alter table public.estoque_mov enable row level security;

alter table public.pecas enable row level security;


-- ---------------------------------------------------------------------
-- Políticas de acesso
-- ---------------------------------------------------------------------

create policy "compras da oficina" on public.compras for all using ((oficina_id = minha_oficina())) with check ((oficina_id = minha_oficina()));

create policy "itens da compra" on public.compra_itens for all using ((EXISTS ( SELECT 1
   FROM compras c
  WHERE ((c.id = compra_itens.compra_id) AND (c.oficina_id = minha_oficina()))))) with check ((EXISTS ( SELECT 1
   FROM compras c
  WHERE ((c.id = compra_itens.compra_id) AND (c.oficina_id = minha_oficina())))));

create policy "le movimentacoes" on public.estoque_mov for select using ((oficina_id = minha_oficina()));

create policy "pecas da oficina" on public.pecas for all using ((oficina_id = minha_oficina())) with check ((oficina_id = minha_oficina()));

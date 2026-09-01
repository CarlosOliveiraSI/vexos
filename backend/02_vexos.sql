-- =====================================================================
-- VexOS — Ordens de serviço
--
-- Módulo adicional da assinatura Vextron. Registro de serviço e
-- histórico do veículo: sem estoque, sem financeiro, sem nota fiscal.
--
-- Pendura na estrutura que já existe (oficinas, perfis) — a mesma conta
-- serve para o app e para a web, e o RLS que isola uma oficina da outra
-- continua valendo aqui.
--
-- Rodar no SQL Editor do Supabase, DEPOIS do contas_supabase.sql.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Módulos contratados
--
-- O VexOS é adicional: quem assina o Vextron não recebe automaticamente.
-- Um campo na oficina diz o que ela contratou.
--
-- Array de texto em vez de uma coluna por módulo: acrescentar um módulo
-- novo depois não exige alterar a tabela nem migrar nada.
-- ---------------------------------------------------------------------
alter table oficinas
    add column if not exists modulos text[] not null default '{}';

comment on column oficinas.modulos is
    'Módulos adicionais contratados. Hoje: ''vexos''. Vazio = só o Vextron.';

create or replace function tem_modulo(p_modulo text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists(
        select 1 from oficinas o
        where o.id = minha_oficina()
          and p_modulo = any(o.modulos)
          and o.status = 'ativa'
          and o.validade > now()
    );
$$;

grant execute on function tem_modulo(text) to authenticated;


-- ---------------------------------------------------------------------
-- 2. Clientes
-- ---------------------------------------------------------------------
create table if not exists clientes (
    id          uuid primary key default gen_random_uuid(),
    oficina_id  uuid not null references oficinas(id) on delete cascade,
    nome        text not null,
    telefone    text,
    email       text,
    documento   text,                 -- CPF/CNPJ, opcional
    observacoes text,
    criado_em   timestamptz not null default now(),
    atualizado_em timestamptz not null default now()
);

create index if not exists idx_clientes_oficina on clientes (oficina_id);
-- Busca por nome sem diferenciar maiúscula/acento é o uso real no balcão
create index if not exists idx_clientes_nome
    on clientes (oficina_id, lower(nome));


-- ---------------------------------------------------------------------
-- 3. Veículos
--
-- A PLACA é a chave, e o cliente é o DONO ATUAL — não o proprietário
-- do registro. Carro é vendido, cliente troca de carro, e o histórico
-- técnico pertence ao veículo: se a mesma placa voltar com outro dono,
-- o remap que você fez há dois anos continua registrado.
--
-- Amarrar o histórico à pessoa perderia exatamente a informação que
-- mais vale.
-- ---------------------------------------------------------------------
create table if not exists veiculos (
    id            uuid primary key default gen_random_uuid(),
    oficina_id    uuid not null references oficinas(id) on delete cascade,
    -- Dono atual. Pode ficar nulo: às vezes o carro chega antes de
    -- alguém cadastrar o cliente.
    cliente_id    uuid references clientes(id) on delete set null,

    placa         text not null,
    marca         text,
    modelo        text,
    ano           text,
    motor         text,
    combustivel   text,
    km            integer,
    chassi        text,
    ecu           text,               -- preenchido pelo Vextron quando identifica
    observacoes   text,
    criado_em     timestamptz not null default now(),
    atualizado_em timestamptz not null default now(),

    -- Uma placa por oficina. Sem isso, o mesmo carro entraria duas vezes
    -- e o histórico ficaria partido entre os dois registros.
    unique (oficina_id, placa)
);

create index if not exists idx_veiculos_oficina on veiculos (oficina_id);
create index if not exists idx_veiculos_cliente on veiculos (cliente_id);


-- ---------------------------------------------------------------------
-- 4. Ordens de serviço
--
-- Sem etapas obrigatórias: cada oficina trabalha de um jeito. Três
-- situações apenas, e a descrição é livre.
-- ---------------------------------------------------------------------
create table if not exists ordens_servico (
    id          uuid primary key default gen_random_uuid(),
    oficina_id  uuid not null references oficinas(id) on delete cascade,
    -- Sequencial POR OFICINA, para você dizer "é a OS 47" no telefone.
    -- Sem o ano: o ano já está na data e obrigaria a decidir o que fazer
    -- na virada.
    numero      integer not null,

    veiculo_id  uuid references veiculos(id) on delete set null,
    cliente_id  uuid references clientes(id) on delete set null,

    status      text not null default 'aberta'
                check (status in ('aberta', 'andamento', 'concluida',
                                  'cancelada')),

    km_entrada  integer,
    descricao   text,                 -- o que o cliente relatou
    diagnostico text,                 -- o que a oficina encontrou
    observacoes text,

    aberta_em     timestamptz not null default now(),
    concluida_em  timestamptz,
    atualizada_em timestamptz not null default now(),
    criada_por    uuid references auth.users(id),

    unique (oficina_id, numero)
);

create index if not exists idx_os_oficina
    on ordens_servico (oficina_id, status, aberta_em desc);
create index if not exists idx_os_veiculo on ordens_servico (veiculo_id);


-- ---------------------------------------------------------------------
-- 5. Itens da ordem
--
-- Linhas livres: serviço, peça, o que for. O valor é OPCIONAL — quem
-- cobra pela OS usa, quem só registra o serviço deixa em branco.
-- ---------------------------------------------------------------------
create table if not exists os_itens (
    id          uuid primary key default gen_random_uuid(),
    os_id       uuid not null references ordens_servico(id) on delete cascade,
    descricao   text not null,
    quantidade  numeric(10,2) not null default 1,
    valor_unit  numeric(12,2),        -- nulo = sem valor
    ordem       integer not null default 0,
    criado_em   timestamptz not null default now()
);

create index if not exists idx_os_itens on os_itens (os_id, ordem);


-- ---------------------------------------------------------------------
-- 6. Análises de ECU anexadas
--
-- É a ligação com o Vextron desktop, e o que nenhum sistema de oficina
-- tem. O técnico compara os arquivos no app e anexa o resultado à OS.
--
-- Guardamos os HASHES, não os arquivos: identificam o binário sem
-- ambiguidade e ocupam 64 caracteres em vez de 4 MB. O laudo em PDF
-- fica no computador de quem gerou.
-- ---------------------------------------------------------------------
create table if not exists os_analises (
    id            uuid primary key default gen_random_uuid(),
    os_id         uuid not null references ordens_servico(id) on delete cascade,
    oficina_id    uuid not null references oficinas(id) on delete cascade,

    tipo          text not null default 'comparacao'
                  check (tipo in ('identificacao', 'comparacao')),

    arquivo_a     text,               -- nome do original
    arquivo_b     text,               -- nome do modificado
    sha_a         text,
    sha_b         text,
    ecu           text,
    identificadores text[],

    -- Resumo do que mudou, para aparecer na web sem abrir o app
    bytes_alterados integer,
    blocos          integer,
    isolados        integer,
    resumo          text,

    registrada_em timestamptz not null default now(),
    registrada_por uuid references auth.users(id)
);

create index if not exists idx_analises_os on os_analises (os_id);
-- Buscar por hash responde "este arquivo já foi usado em qual carro?"
create index if not exists idx_analises_sha
    on os_analises (oficina_id, sha_b);


-- ---------------------------------------------------------------------
-- 7. Numeração automática
--
-- O número é gerado no banco, dentro da mesma operação da inserção.
-- Contando fora e inserindo depois, duas OS abertas ao mesmo tempo
-- receberiam o mesmo número — e o índice único faria a segunda falhar
-- na cara do usuário.
-- ---------------------------------------------------------------------
create or replace function proximo_numero_os()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.numero is null or new.numero = 0 then
        select coalesce(max(numero), 0) + 1 into new.numero
        from ordens_servico where oficina_id = new.oficina_id;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_numero_os on ordens_servico;
create trigger trg_numero_os
    before insert on ordens_servico
    for each row execute function proximo_numero_os();


-- Mantém `atualizado_em` em dia sem depender de quem escreve o código
create or replace function tocar_atualizado()
returns trigger language plpgsql as $$
begin
    if TG_TABLE_NAME = 'ordens_servico' then
        new.atualizada_em := now();
    else
        new.atualizado_em := now();
    end if;
    return new;
end;
$$;

drop trigger if exists trg_toca_clientes on clientes;
create trigger trg_toca_clientes before update on clientes
    for each row execute function tocar_atualizado();
drop trigger if exists trg_toca_veiculos on veiculos;
create trigger trg_toca_veiculos before update on veiculos
    for each row execute function tocar_atualizado();
drop trigger if exists trg_toca_os on ordens_servico;
create trigger trg_toca_os before update on ordens_servico
    for each row execute function tocar_atualizado();


-- ---------------------------------------------------------------------
-- 8. Segurança
--
-- Cada oficina vê apenas os próprios dados, e SÓ se tiver o módulo
-- contratado. Sem a checagem de módulo, quem cancelasse o adicional
-- continuaria usando pela API — a tela esconde, o banco é que impede.
--
-- Exceção deliberada na LEITURA: quem já cadastrou dados e depois
-- cancelou continua enxergando o que é seu. Perder acesso ao próprio
-- histórico por atraso de pagamento é o tipo de coisa que faz o cliente
-- não voltar nunca mais. Escrever, aí sim, exige o módulo ativo.
-- ---------------------------------------------------------------------
alter table clientes        enable row level security;
alter table veiculos        enable row level security;
alter table ordens_servico  enable row level security;
alter table os_itens        enable row level security;
alter table os_analises     enable row level security;

-- clientes
drop policy if exists "le clientes" on clientes;
create policy "le clientes" on clientes
    for select using (oficina_id = minha_oficina());
drop policy if exists "grava clientes" on clientes;
create policy "grava clientes" on clientes
    for insert with check (oficina_id = minha_oficina() and tem_modulo('vexos'));
drop policy if exists "edita clientes" on clientes;
create policy "edita clientes" on clientes
    for update using (oficina_id = minha_oficina() and tem_modulo('vexos'))
    with check (oficina_id = minha_oficina());
drop policy if exists "apaga clientes" on clientes;
create policy "apaga clientes" on clientes
    for delete using (oficina_id = minha_oficina() and tem_modulo('vexos'));

-- veiculos
drop policy if exists "le veiculos" on veiculos;
create policy "le veiculos" on veiculos
    for select using (oficina_id = minha_oficina());
drop policy if exists "grava veiculos" on veiculos;
create policy "grava veiculos" on veiculos
    for insert with check (oficina_id = minha_oficina() and tem_modulo('vexos'));
drop policy if exists "edita veiculos" on veiculos;
create policy "edita veiculos" on veiculos
    for update using (oficina_id = minha_oficina() and tem_modulo('vexos'))
    with check (oficina_id = minha_oficina());
drop policy if exists "apaga veiculos" on veiculos;
create policy "apaga veiculos" on veiculos
    for delete using (oficina_id = minha_oficina() and tem_modulo('vexos'));

-- ordens
drop policy if exists "le os" on ordens_servico;
create policy "le os" on ordens_servico
    for select using (oficina_id = minha_oficina());
drop policy if exists "grava os" on ordens_servico;
create policy "grava os" on ordens_servico
    for insert with check (oficina_id = minha_oficina() and tem_modulo('vexos'));
drop policy if exists "edita os" on ordens_servico;
create policy "edita os" on ordens_servico
    for update using (oficina_id = minha_oficina() and tem_modulo('vexos'))
    with check (oficina_id = minha_oficina());
drop policy if exists "apaga os" on ordens_servico;
create policy "apaga os" on ordens_servico
    for delete using (oficina_id = minha_oficina() and tem_modulo('vexos'));

-- itens: seguem a ordem a que pertencem
drop policy if exists "le itens" on os_itens;
create policy "le itens" on os_itens
    for select using (exists(
        select 1 from ordens_servico o
        where o.id = os_itens.os_id and o.oficina_id = minha_oficina()));
drop policy if exists "grava itens" on os_itens;
create policy "grava itens" on os_itens
    for insert with check (tem_modulo('vexos') and exists(
        select 1 from ordens_servico o
        where o.id = os_itens.os_id and o.oficina_id = minha_oficina()));
drop policy if exists "edita itens" on os_itens;
create policy "edita itens" on os_itens
    for update using (tem_modulo('vexos') and exists(
        select 1 from ordens_servico o
        where o.id = os_itens.os_id and o.oficina_id = minha_oficina()));
drop policy if exists "apaga itens" on os_itens;
create policy "apaga itens" on os_itens
    for delete using (tem_modulo('vexos') and exists(
        select 1 from ordens_servico o
        where o.id = os_itens.os_id and o.oficina_id = minha_oficina()));

-- análises
drop policy if exists "le analises" on os_analises;
create policy "le analises" on os_analises
    for select using (oficina_id = minha_oficina());
drop policy if exists "grava analises" on os_analises;
create policy "grava analises" on os_analises
    for insert with check (oficina_id = minha_oficina() and tem_modulo('vexos'));
drop policy if exists "apaga analises" on os_analises;
create policy "apaga analises" on os_analises
    for delete using (oficina_id = minha_oficina() and tem_modulo('vexos'));


-- ---------------------------------------------------------------------
-- 9. Consultas prontas
-- ---------------------------------------------------------------------

-- Histórico do veículo: o que dá valor ao sistema. Toda vez que aquela
-- placa voltar, o que já foi feito nela aparece — inclusive de quando
-- o dono era outro.
create or replace view historico_veiculo as
select
    v.id              as veiculo_id,
    v.oficina_id,
    v.placa,
    o.id              as os_id,
    o.numero,
    o.status,
    o.aberta_em,
    o.concluida_em,
    o.km_entrada,
    o.descricao,
    o.diagnostico,
    c.nome            as cliente_na_epoca,
    (select count(*) from os_analises a where a.os_id = o.id)
                      as analises
from veiculos v
join ordens_servico o on o.veiculo_id = v.id
left join clientes c  on c.id = o.cliente_id
order by o.aberta_em desc;


-- =====================================================================
-- USO NO DIA A DIA
-- =====================================================================

-- Liberar o VexOS para uma oficina:
--
-- update oficinas
-- set modulos = array_append(modulos, 'vexos')
-- where id = '<uuid-da-oficina>' and not ('vexos' = any(modulos));

-- Tirar o módulo:
--
-- update oficinas
-- set modulos = array_remove(modulos, 'vexos')
-- where id = '<uuid-da-oficina>';

-- Quem tem o módulo hoje:
--
-- select nome, modulos, validade from oficinas
-- where 'vexos' = any(modulos) order by nome;

-- Histórico de uma placa:
--
-- select numero, aberta_em, status, descricao, cliente_na_epoca, analises
-- from historico_veiculo
-- where placa = 'ABC1D23' order by aberta_em desc;

-- Este arquivo já foi gravado em qual carro?
--
-- select v.placa, o.numero, a.registrada_em
-- from os_analises a
-- join ordens_servico o on o.id = a.os_id
-- left join veiculos v on v.id = o.veiculo_id
-- where a.sha_b = '<hash>';

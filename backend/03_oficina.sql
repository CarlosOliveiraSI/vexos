-- =====================================================================
-- VexOS — Dados de identificação da oficina (cabeçalho da OS impressa)
--
-- Rodar no SQL Editor do Supabase, DEPOIS de 01_contas.sql e 02_vexos.sql.
--
-- Até aqui a tabela `oficinas` era só administrativa: nome, status,
-- validade da assinatura. Para entregar a ordem de serviço ao cliente
-- ela precisa virar também a identidade visual da empresa — logo,
-- endereço, contato.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Colunas novas
--
-- A LOGO fica como data URL (base64) na própria linha, e não no Storage.
-- O motivo é a impressão: o PDF é gerado pelo navegador, e uma imagem
-- buscada de outro domínio pode não terminar de carregar antes de a
-- janela de impressão abrir — a logo sai em branco, sem erro nenhum na
-- tela. Em base64 ela chega junto com os dados da oficina.
--
-- O custo é uma coluna de texto pesada, então ela NUNCA entra num
-- select=*: o frontend pede a logo só na tela de configuração e na hora
-- de imprimir.
-- ---------------------------------------------------------------------
alter table oficinas
    add column if not exists logo        text,
    add column if not exists endereco    text,
    add column if not exists cidade      text,
    add column if not exists uf          text,
    add column if not exists cep         text,
    add column if not exists email       text,
    add column if not exists rodape_os   text;

comment on column oficinas.logo is
    'Logo em data URL (base64), já redimensionada pelo navegador. Sai no cabeçalho da OS impressa.';
comment on column oficinas.rodape_os is
    'Texto livre no rodapé da OS impressa: garantia, condições de pagamento, o que a oficina quiser.';


-- ---------------------------------------------------------------------
-- 2. Quem sou eu nesta oficina
--
-- Mesmo desenho do minha_oficina(): security definer para poder ser
-- usada dentro de uma política sobre `perfis` sem recursão.
-- ---------------------------------------------------------------------
create or replace function meu_papel()
returns text
language sql
stable
security definer
set search_path = public
as $$
    select papel from perfis where id = auth.uid() and ativo;
$$;

grant execute on function meu_papel() to authenticated;


-- ---------------------------------------------------------------------
-- 3. Permissão de escrita — a parte que importa
--
-- A tabela `oficinas` guarda `status` e `validade`, que é o que decide
-- se a assinatura está paga. Uma política de UPDATE aberta deixaria o
-- dono da oficina mandar um PATCH com validade = 2099 pelo console do
-- navegador e liberar o sistema para sempre. RLS não sabe restringir
-- COLUNA — só linha. Quem faz isso é o GRANT por coluna.
--
-- Por isso a ordem aqui é: tira o update inteiro, devolve só as colunas
-- de identidade visual. Assim, mesmo que a política deixe passar, o
-- banco recusa a escrita em `validade`, `status`, `modulos` e
-- `max_maquinas`.
-- ---------------------------------------------------------------------
revoke update on oficinas from authenticated;

grant update (logo, endereco, cidade, uf, cep, email,
              rodape_os, telefone, documento, nome)
    on oficinas to authenticated;

drop policy if exists "edita dados da oficina" on oficinas;
create policy "edita dados da oficina" on oficinas
    for update
    using (id = minha_oficina() and meu_papel() in ('dono', 'admin'))
    with check (id = minha_oficina());


-- ---------------------------------------------------------------------
-- 4. Conferência
--
-- Rode depois de aplicar. A primeira consulta deve listar SOMENTE as
-- colunas liberadas acima; se `validade` ou `status` aparecerem, o
-- revoke não pegou e a brecha do item 3 continua aberta.
-- ---------------------------------------------------------------------
-- select column_name
--   from information_schema.column_privileges
--  where table_name = 'oficinas'
--    and grantee = 'authenticated'
--    and privilege_type = 'UPDATE'
--  order by column_name;

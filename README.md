# VexOS

Sistema de ordens de serviço para oficina. Módulo adicional da
assinatura Motronix Vextron.

**vexos.motronixtech.com.br**

---

## Estrutura

```
frontend/    as páginas — é o que a Vercel publica
backend/     o banco: tabelas, políticas de segurança e funções
vercel.json  aponta a publicação para frontend/
```

### Não há servidor próprio

As páginas falam **direto** com o Supabase. Quem protege os dados é o
RLS do banco, não código intermediário: mesmo que alguém edite o
JavaScript no navegador, não alcança dados de outra oficina nem escreve
sem o módulo contratado.

Por isso a pasta `backend/` tem SQL, e não código. É ali que está a
lógica de segurança — e ela precisa estar versionada junto, senão vive
só no painel do Supabase, onde ninguém revisa nem tem histórico.

---

## frontend/

| Arquivo | O que é |
|---|---|
| `index.html` | login |
| `ordens.html` | lista de ordens, com busca e filtro |
| `ordem.html` | uma ordem: veículo, cliente, itens, análises, histórico |
| `veiculos.html` | lista de veículos |
| `veiculo.html` | ficha e histórico completo de uma placa |
| `clientes.html` | lista e cadastro de clientes |
| `app.js` | configuração, sessão e acesso ao banco |
| `vexos.css` | estilo |
| `favicon.svg` | ícone |

## backend/

Rodar **na ordem**, no SQL Editor do Supabase:

| Arquivo | O que cria |
|---|---|
| `01_contas.sql` | oficinas, perfis, máquinas. **Compartilhado com o Vextron desktop** — se já rodou lá, não precisa rodar de novo. |
| `02_vexos.sql` | clientes, veículos, ordens, itens, análises e o controle do módulo. Depende do 01. |

---

## Publicar

A Vercel republica sozinha a cada push na branch principal.

```
git add .
git commit -m "o que mudou"
git push
```

**Ao criar o projeto na Vercel**, o `vercel.json` já resolve a pasta.
Se ela ainda publicar a raiz, confira em Settings → General se o
**Root Directory** está vazio — preenchido, ele briga com o
`outputDirectory`.

---

## Configuração

`frontend/app.js`, primeira seção:

```js
url:   "https://SEU-PROJETO.supabase.co",
chave: "sb_publishable_...",
```

A chave **publicável**, nunca a secret. Pode ficar no código: é feita
para o navegador, e quem protege os dados é o RLS.

No Supabase, **Authentication → URL Configuration**:

- Site URL: `https://vexos.motronixtech.com.br`
- Redirect URLs: `https://vexos.motronixtech.com.br/**`

Sem isso o login é recusado com um erro que não explica o motivo.

---

## Ativar para uma oficina

O VexOS é adicional: quem assina o Vextron não recebe automaticamente.

```sql
update oficinas set modulos = array_append(modulos, 'vexos')
where nome = 'Nome da Oficina';
```

Conferir os três requisitos de uma vez — módulo, situação e validade:

```sql
select nome, modulos, status, validade from oficinas;
```

Sem o módulo, a tela mostra o convite para ativar. Isso é conveniência;
quem impede de verdade é o RLS.

---

## Decisões que não são óbvias no código

**A placa é a chave, o cliente é o dono atual.** Carro é vendido, e o
histórico técnico pertence ao veículo. Se a mesma placa voltar com
outro dono, o remap de dois anos atrás continua registrado, com o nome
de quem era dono na época.

**A numeração das ordens é gerada no banco**, por trigger, dentro da
mesma operação da inserção. Contando fora e inserindo depois, duas
ordens abertas ao mesmo tempo receberiam o mesmo número.

**Ler continua, escrever não.** Quem cancela o módulo continua vendo o
próprio histórico — só não cria mais nada. Perder acesso ao que é seu
por atraso de pagamento faz o cliente não voltar.

**Valor é opcional.** O total só aparece se alguém preencher algum
valor; quem usa a ordem só para registrar o serviço não vê "R$ 0,00".

**Sem estoque, financeiro ou nota fiscal** — deliberadamente. Com os
três, o produto competiria com ERPs estabelecidos em terreno onde não
tem vantagem.

---

## O que falta

- Botão no Vextron desktop para anexar a análise a uma ordem —
  a tabela `os_analises` já existe e as telas já exibem o que houver
- Impressão da ordem em PDF

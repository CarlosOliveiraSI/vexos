/* =====================================================================
 * VexOS — nota-conferencia.js
 * Tela de conferência da nota importada: vincula cada item a uma peça do
 * catálogo, confere os totais e grava/lança no estoque.
 *
 * Depende de nota-import.js e de um client Supabase já autenticado.
 *
 * Configuração (uma vez, no carregamento da tela de estoque):
 *   NotaConferencia.configurar({
 *     sb: supabase,                  // client já logado
 *     oficinaId: '...',              // uuid da oficina do usuário
 *     aoConcluir: (nota) => {...}    // callback após salvar/lançar
 *   });
 *
 * Abertura:
 *   NotaConferencia.abrir(notaLida)  // objeto vindo de NotaImport.ler()
 * ===================================================================== */
(function (global) {
  'use strict';

  const cfg = { sb: null, oficinaId: null, aoConcluir: null };
  let estado = null;
  let raiz = null;

  const moeda = (n) =>
    (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const qtd = (n) =>
    (Number(n) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 4 });
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function configurar(opcoes) {
    Object.assign(cfg, opcoes || {});
  }

  // ------------------------------------------------------------------
  // Consultas ao Supabase
  // ------------------------------------------------------------------
  async function acharFornecedor(cnpj, nome) {
    if (!cnpj && !nome) return null;
    let q = cfg.sb.from('fornecedores').select('*').limit(1);
    q = cnpj ? q.eq('cnpj', cnpj) : q.ilike('nome', nome);
    const { data, error } = await q;
    if (error) throw error;
    return (data && data[0]) || null;
  }

  async function garantirFornecedor(dados) {
    const existente = await acharFornecedor(dados.cnpj, dados.nome);
    if (existente) return existente;
    const { data, error } = await cfg.sb
      .from('fornecedores')
      .insert({
        oficina_id: cfg.oficinaId,
        cnpj: dados.cnpj || null,
        nome: dados.nome || 'Fornecedor sem nome',
        nome_fantasia: dados.fantasia || null,
        inscricao_est: dados.ie || null
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async function notaJaExiste(chave) {
    if (!chave) return null;
    const { data, error } = await cfg.sb
      .from('notas_compra')
      .select('id, numero, status, emissao')
      .eq('chave_acesso', chave)
      .limit(1);
    if (error) throw error;
    return (data && data[0]) || null;
  }

  /** Resolve o vínculo de cada item: de-para → EAN → nome aproximado. */
  async function resolverVinculos(itens, fornecedorId) {
    const codigos = itens.map((i) => i.codigoFornecedor).filter(Boolean);
    const eans = itens.map((i) => i.ean).filter(Boolean);

    let dePara = [];
    if (fornecedorId && codigos.length) {
      const { data } = await cfg.sb
        .from('fornecedor_peca_codigo')
        .select('codigo_fornecedor, peca_id, fator_conversao, pecas(id, codigo, nome, unidade)')
        .eq('fornecedor_id', fornecedorId)
        .in('codigo_fornecedor', codigos);
      dePara = data || [];
    }

    let porEan = [];
    if (eans.length) {
      const { data } = await cfg.sb
        .from('pecas')
        .select('id, codigo, nome, unidade, codigo_barras')
        .in('codigo_barras', eans);
      porEan = data || [];
    }

    itens.forEach((item) => {
      const v = dePara.find((d) => d.codigo_fornecedor === item.codigoFornecedor);
      if (v && v.pecas) {
        item.peca = v.pecas;
        item.fatorConversao = Number(v.fator_conversao) || 1;
        item.vinculo = 'codigo';
        return;
      }
      const e = item.ean && porEan.find((p) => p.codigo_barras === item.ean);
      if (e) { item.peca = e; item.vinculo = 'ean'; return; }
      item.peca = null;
      item.vinculo = 'pendente';
    });
    return itens;
  }

  async function buscarPecas(termo) {
    if (!termo || termo.length < 2) return [];
    const { data, error } = await cfg.sb
      .from('pecas')
      .select('id, codigo, nome, unidade, saldo')
      .or(`nome.ilike.%${termo}%,codigo.ilike.%${termo}%`)
      .limit(12);
    if (error) throw error;
    return data || [];
  }

  async function criarPeca(item) {
    const { data, error } = await cfg.sb
      .from('pecas')
      .insert({
        oficina_id: cfg.oficinaId,
        codigo: item.codigoFornecedor || null,
        nome: item.descricao,
        unidade: item.unidade || 'UN',
        codigo_barras: item.ean || null,
        saldo: 0,
        custo_medio: item.custoUnitario
      })
      .select('id, codigo, nome, unidade')
      .single();
    if (error) throw error;
    return data;
  }

  // ------------------------------------------------------------------
  // Cálculos de conferência
  // ------------------------------------------------------------------
  function somaItens() {
    return estado.itens.reduce(
      (s, i) => s + i.custoUnitario * i.quantidade * (i.fatorConversao || 1) / (i.fatorConversao || 1),
      0
    );
  }

  function diferenca() {
    const soma = estado.itens.reduce((s, i) => s + i.custoUnitario * i.quantidade, 0);
    return NotaImport.arred((estado.totais.nota || 0) - soma, 2);
  }

  function pendencias() {
    const lista = [];
    const semVinculo = estado.itens.filter((i) => !i.peca).length;
    if (semVinculo) lista.push(`${semVinculo} item(ns) sem peça vinculada`);
    if (Math.abs(diferenca()) > 0.05 && !estado.divergenciaAceita) {
      lista.push(`soma dos itens difere do total da nota em ${moeda(Math.abs(diferenca()))}`);
    }
    if (!estado.fornecedor) lista.push('fornecedor não identificado');
    if (!estado.emissao) lista.push('data de emissão em branco');
    return lista;
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  function linhaItem(item, idx) {
    const rotulo = {
      codigo: 'vinculada pelo código do fornecedor',
      ean: 'vinculada pelo código de barras',
      manual: 'vinculada agora',
      nova: 'peça nova',
      pendente: 'escolha a peça'
    }[item.vinculo] || '';

    const classe = item.peca ? 'nc-ok' : 'nc-pendente';

    return `
      <tr class="${classe}" data-idx="${idx}">
        <td class="nc-col-origem">
          <div class="nc-desc">${esc(item.descricao)}</div>
          <div class="nc-meta">
            ${item.codigoFornecedor ? 'cód. ' + esc(item.codigoFornecedor) : ''}
            ${item.ean ? ' · EAN ' + esc(item.ean) : ''}
            ${item.ncm ? ' · NCM ' + esc(item.ncm) : ''}
          </div>
        </td>
        <td class="nc-col-peca">
          ${item.peca
            ? `<button type="button" class="nc-peca-sel" data-acao="trocar">
                 <span>${esc(item.peca.nome)}</span>
                 <small>${esc(rotulo)}</small>
               </button>`
            : `<input type="text" class="nc-busca" data-acao="buscar"
                      placeholder="buscar peça pelo nome ou código"
                      autocomplete="off" value="">
               <div class="nc-sugestoes" hidden></div>
               <button type="button" class="nc-link" data-acao="criar">criar peça nova</button>`}
        </td>
        <td class="nc-col-num">
          <input type="number" step="0.0001" min="0.0001" class="nc-inp nc-qtd"
                 value="${item.quantidade}" data-campo="quantidade">
          <span class="nc-un">${esc(item.unidade)}</span>
        </td>
        <td class="nc-col-num">
          <input type="number" step="0.0001" min="0.0001" class="nc-inp nc-fator"
                 value="${item.fatorConversao || 1}" data-campo="fatorConversao"
                 title="Quantas unidades do seu estoque cabem em 1 ${esc(item.unidade)}">
        </td>
        <td class="nc-col-num nc-custo">${moeda(item.custoUnitario)}</td>
        <td class="nc-col-num nc-entra">
          <strong>${qtd(item.quantidade * (item.fatorConversao || 1))}</strong>
        </td>
        <td class="nc-col-acao">
          <button type="button" class="nc-remover" data-acao="remover" title="Remover item">×</button>
        </td>
      </tr>`;
  }

  function render() {
    const dif = diferenca();
    const pend = pendencias();
    const conf = estado.confianca.itens;

    raiz.innerHTML = `
      <div class="nc-overlay">
        <div class="nc-modal" role="dialog" aria-modal="true" aria-label="Conferir nota importada">

          <header class="nc-topo">
            <div>
              <h2>Conferir nota</h2>
              <p class="nc-sub">${estado.origem === 'xml'
                ? 'Lida do XML da NFe. Os valores vieram prontos do arquivo.'
                : 'Lida do DANFE em PDF. Confira item por item antes de lançar.'}</p>
            </div>
            <button type="button" class="nc-fechar" data-acao="fechar" aria-label="Fechar">×</button>
          </header>

          ${conf === 'baixa' ? `
            <div class="nc-alerta nc-alerta-forte">
              A leitura dos itens ficou incompleta. Complete o que faltar antes de lançar.
            </div>` : ''}

          ${estado.avisos.length ? `
            <ul class="nc-avisos">
              ${estado.avisos.map((a) => `<li>${esc(a)}</li>`).join('')}
            </ul>` : ''}

          <section class="nc-cabecalho">
            <label>Fornecedor
              <input type="text" id="nc-fornecedor" value="${esc(estado.fornecedorNome)}">
            </label>
            <label>Número
              <input type="text" id="nc-numero" value="${esc(estado.numero)}">
            </label>
            <label>Série
              <input type="text" id="nc-serie" value="${esc(estado.serie)}">
            </label>
            <label>Emissão
              <input type="date" id="nc-emissao" value="${esc(estado.emissao)}">
            </label>
            ${estado.chave ? `
              <div class="nc-chave">
                <span>Chave de acesso</span>
                <code>${esc(estado.chave)}</code>
              </div>` : ''}
          </section>

          <div class="nc-tabela-wrap">
            <table class="nc-tabela">
              <thead>
                <tr>
                  <th>Item da nota</th>
                  <th>Peça no seu estoque</th>
                  <th>Qtd</th>
                  <th>Fator</th>
                  <th>Custo un.</th>
                  <th>Entra</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${estado.itens.map(linhaItem).join('')}
              </tbody>
            </table>
          </div>

          <section class="nc-totais">
            <div>
              <span>Soma dos itens</span>
              <strong>${moeda(estado.itens.reduce((s, i) => s + i.custoUnitario * i.quantidade, 0))}</strong>
            </div>
            <div>
              <span>Total da nota</span>
              <strong>${moeda(estado.totais.nota)}</strong>
            </div>
            <div class="${Math.abs(dif) > 0.05 ? 'nc-dif' : 'nc-dif-ok'}">
              <span>Diferença</span>
              <strong>${moeda(dif)}</strong>
            </div>
          </section>

          ${Math.abs(dif) > 0.05 ? `
            <label class="nc-aceitar">
              <input type="checkbox" id="nc-aceita" ${estado.divergenciaAceita ? 'checked' : ''}>
              Lançar mesmo com a diferença — conferi e está correto
            </label>` : ''}

          <footer class="nc-rodape">
            <p class="nc-pendencias">${pend.length
              ? 'Falta resolver: ' + esc(pend.join('; '))
              : 'Tudo conferido.'}</p>
            <div class="nc-botoes">
              <button type="button" class="nc-btn" data-acao="fechar">Cancelar</button>
              <button type="button" class="nc-btn" data-acao="rascunho">Salvar rascunho</button>
              <button type="button" class="nc-btn nc-btn-primario"
                      data-acao="lancar" ${pend.length ? 'disabled' : ''}>
                Lançar no estoque
              </button>
            </div>
          </footer>
        </div>
      </div>`;

    ligarEventos();
  }

  // ------------------------------------------------------------------
  // Eventos
  // ------------------------------------------------------------------
  function ligarEventos() {
    const modal = raiz.querySelector('.nc-modal');

    raiz.querySelectorAll('[data-acao="fechar"]').forEach((b) =>
      b.addEventListener('click', fechar));

    const aceita = raiz.querySelector('#nc-aceita');
    if (aceita) aceita.addEventListener('change', (e) => {
      estado.divergenciaAceita = e.target.checked;
      render();
    });

    ['fornecedor', 'numero', 'serie', 'emissao'].forEach((campo) => {
      const el = raiz.querySelector('#nc-' + campo);
      if (!el) return;
      el.addEventListener('change', () => {
        if (campo === 'fornecedor') estado.fornecedorNome = el.value;
        else estado[campo] = el.value;
      });
    });

    modal.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-acao]');
      if (!btn) return;
      const tr = btn.closest('tr');
      const idx = tr ? Number(tr.dataset.idx) : -1;
      const acao = btn.dataset.acao;

      if (acao === 'remover') {
        estado.itens.splice(idx, 1);
        return render();
      }
      if (acao === 'trocar') {
        estado.itens[idx].peca = null;
        estado.itens[idx].vinculo = 'pendente';
        return render();
      }
      if (acao === 'criar') {
        btn.disabled = true;
        try {
          const peca = await criarPeca(estado.itens[idx]);
          estado.itens[idx].peca = peca;
          estado.itens[idx].vinculo = 'nova';
          render();
        } catch (e) {
          alert('Não foi possível criar a peça: ' + e.message);
          btn.disabled = false;
        }
      }
      if (acao === 'rascunho') return salvar(false, btn);
      if (acao === 'lancar') return salvar(true, btn);
    });

    // Busca de peça com debounce
    modal.querySelectorAll('.nc-busca').forEach((input) => {
      let timer;
      const caixa = input.parentElement.querySelector('.nc-sugestoes');
      const idx = Number(input.closest('tr').dataset.idx);

      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const lista = await buscarPecas(input.value.trim());
          if (!lista.length) { caixa.hidden = true; return; }
          caixa.innerHTML = lista.map((p) =>
            `<button type="button" data-id="${p.id}">
               <span>${esc(p.nome)}</span>
               <small>${esc(p.codigo || '')} · saldo ${qtd(p.saldo)}</small>
             </button>`).join('');
          caixa.hidden = false;
          caixa.querySelectorAll('button').forEach((b) =>
            b.addEventListener('click', () => {
              const p = lista.find((x) => x.id === b.dataset.id);
              estado.itens[idx].peca = p;
              estado.itens[idx].vinculo = 'manual';
              render();
            }));
        }, 280);
      });
      input.addEventListener('blur', () => setTimeout(() => { caixa.hidden = true; }, 180));

      // pré-preenche a busca com a descrição da nota
      if (!input.value) input.value = '';
    });

    // Edição de quantidade e fator
    modal.querySelectorAll('.nc-inp').forEach((inp) => {
      inp.addEventListener('change', () => {
        const idx = Number(inp.closest('tr').dataset.idx);
        const campo = inp.dataset.campo;
        const valor = parseFloat(inp.value);
        if (!(valor > 0)) { inp.value = estado.itens[idx][campo]; return; }
        estado.itens[idx][campo] = valor;
        if (campo === 'quantidade') NotaImport.calcularCusto(estado.itens[idx]);
        render();
      });
    });

    document.addEventListener('keydown', escFecha);
  }

  function escFecha(e) { if (e.key === 'Escape') fechar(); }

  function fechar() {
    document.removeEventListener('keydown', escFecha);
    if (raiz) raiz.innerHTML = '';
    estado = null;
  }

  // ------------------------------------------------------------------
  // Gravação
  // ------------------------------------------------------------------
  async function salvar(lancar, botao) {
    const original = botao.textContent;
    botao.disabled = true;
    botao.textContent = lancar ? 'Lançando…' : 'Salvando…';

    try {
      const fornecedor = await garantirFornecedor({
        cnpj: estado.fornecedorCnpj,
        nome: estado.fornecedorNome,
        fantasia: estado.fornecedorFantasia,
        ie: estado.fornecedorIe
      });

      const { data: nota, error: e1 } = await cfg.sb
        .from('notas_compra')
        .insert({
          oficina_id: cfg.oficinaId,
          fornecedor_id: fornecedor.id,
          numero: estado.numero || null,
          serie: estado.serie || null,
          chave_acesso: estado.chave || null,
          emissao: estado.emissao || null,
          origem: estado.origem,
          valor_produtos: estado.totais.produtos,
          valor_frete: estado.totais.frete,
          valor_seguro: estado.totais.seguro,
          valor_desconto: estado.totais.desconto,
          valor_outros: estado.totais.outros,
          valor_ipi: estado.totais.ipi,
          valor_st: estado.totais.st,
          valor_total: estado.totais.nota,
          arquivo_tipo: estado.origem
        })
        .select()
        .single();

      if (e1) {
        if (e1.code === '23505') throw new Error('Esta nota já foi lançada no estoque.');
        throw e1;
      }

      const itens = estado.itens.map((i, n) => ({
        nota_id: nota.id,
        oficina_id: cfg.oficinaId,
        peca_id: i.peca ? i.peca.id : null,
        ordem: n + 1,
        codigo_fornecedor: i.codigoFornecedor || null,
        ean: i.ean || null,
        descricao_origem: i.descricao,
        ncm: i.ncm || null,
        cfop: i.cfop || null,
        unidade_comercial: i.unidade || null,
        fator_conversao: i.fatorConversao || 1,
        quantidade: i.quantidade,
        valor_unitario: i.valorUnitario,
        valor_produtos: i.valorProdutos,
        valor_frete: i.frete,
        valor_seguro: i.seguro,
        valor_desconto: i.desconto,
        valor_outros: i.outros,
        valor_ipi: i.ipi,
        valor_st: i.st,
        custo_unitario: i.custoUnitario
      }));

      const { error: e2 } = await cfg.sb.from('notas_compra_itens').insert(itens);
      if (e2) throw e2;

      // Guarda o de-para para as próximas notas deste fornecedor
      const vinculos = estado.itens
        .filter((i) => i.peca && i.codigoFornecedor)
        .map((i) => ({
          oficina_id: cfg.oficinaId,
          fornecedor_id: fornecedor.id,
          codigo_fornecedor: i.codigoFornecedor,
          peca_id: i.peca.id,
          unidade_comercial: i.unidade || null,
          fator_conversao: i.fatorConversao || 1,
          descricao_origem: i.descricao,
          atualizado_em: new Date().toISOString()
        }));
      if (vinculos.length) {
        await cfg.sb.from('fornecedor_peca_codigo')
          .upsert(vinculos, { onConflict: 'fornecedor_id,codigo_fornecedor' });
      }

      // Arquivo original no Storage
      if (estado.arquivo) {
        const ext = estado.origem === 'xml' ? 'xml' : 'pdf';
        const caminho = `${cfg.oficinaId}/${nota.id}.${ext}`;
        const { error: e3 } = await cfg.sb.storage
          .from('notas-fiscais')
          .upload(caminho, estado.arquivo, { upsert: true });
        if (!e3) {
          await cfg.sb.from('notas_compra')
            .update({ arquivo_path: caminho })
            .eq('id', nota.id);
        }
      }

      if (lancar) {
        const { error: e4 } = await cfg.sb.rpc('lancar_nota_compra', { p_nota: nota.id });
        if (e4) throw e4;
      }

      fechar();
      if (typeof cfg.aoConcluir === 'function') cfg.aoConcluir(nota, lancar);
    } catch (e) {
      alert((lancar ? 'Não foi possível lançar a nota: ' : 'Não foi possível salvar: ') + e.message);
      botao.disabled = false;
      botao.textContent = original;
    }
  }

  // ------------------------------------------------------------------
  // Abertura
  // ------------------------------------------------------------------
  async function abrir(nota, arquivo) {
    if (!cfg.sb) throw new Error('NotaConferencia.configurar() não foi chamado.');

    const duplicada = await notaJaExiste(nota.chave);
    if (duplicada) {
      alert(`Esta nota já está no sistema (nº ${duplicada.numero || '—'}, ${duplicada.status}).`);
      return;
    }

    const fornecedor = await acharFornecedor(nota.fornecedor.cnpj, nota.fornecedor.nome);
    const itens = await resolverVinculos(
      nota.itens.map((i) => Object.assign({}, i)),
      fornecedor ? fornecedor.id : null
    );

    // fator sugerido pela unidade tributável do XML
    itens.forEach((i) => {
      if (!i.fatorConversao || i.fatorConversao === 1) {
        i.fatorConversao = i.fatorSugerido && i.fatorSugerido > 1 ? i.fatorSugerido : 1;
      }
    });

    estado = {
      origem: nota.origem,
      chave: nota.chave || '',
      numero: nota.numero || '',
      serie: nota.serie || '',
      emissao: nota.emissao || new Date().toISOString().slice(0, 10),
      fornecedor: fornecedor,
      fornecedorCnpj: nota.fornecedor.cnpj,
      fornecedorNome: (fornecedor && fornecedor.nome) || nota.fornecedor.nome || '',
      fornecedorFantasia: nota.fornecedor.fantasia,
      fornecedorIe: nota.fornecedor.ie,
      totais: nota.totais,
      confianca: nota.confianca,
      avisos: nota.avisos || [],
      itens,
      arquivo: arquivo || null,
      divergenciaAceita: false
    };

    raiz = document.getElementById('nc-raiz');
    if (!raiz) {
      raiz = document.createElement('div');
      raiz.id = 'nc-raiz';
      document.body.appendChild(raiz);
    }
    render();
  }

  /** Liga um <input type="file"> ao fluxo completo. */
  function ligarInput(input, aoErro) {
    input.addEventListener('change', async () => {
      const arquivos = Array.from(input.files || []);
      if (!arquivos.length) return;
      try {
        const { notas, erros } = await NotaImport.ler(arquivos);
        if (erros.length && typeof aoErro === 'function') aoErro(erros);
        for (const n of notas) {
          const arq = arquivos.find((a) => a.name === n.arquivoNome) || arquivos[0];
          await abrir(n, arq);
          break; // uma nota por vez; as demais ficam para o próximo upload
        }
        if (!notas.length && erros.length) {
          alert('Não consegui ler o arquivo: ' + erros[0].mensagem);
        }
      } catch (e) {
        alert('Não consegui ler o arquivo: ' + e.message);
      } finally {
        input.value = '';
      }
    });
  }

  global.NotaConferencia = { configurar, abrir, ligarInput, fechar };
})(window);

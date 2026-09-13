/* =====================================================================
 * VexOS — nota-conferencia.js  (v2 — adaptado ao VexOS real)
 *
 * Mudou em relação à v1: não usa supabase-js. Fala pelo objeto `Banco`
 * do app.js e grava nas tabelas que já existem — compras, compra_itens,
 * pecas — chamando lancar_compra() para o lançamento.
 *
 * Uso na compras.html, depois de `contexto` estar pronto:
 *   NotaConferencia.configurar({
 *     oficinaId: contexto.oficina_id,
 *     aoConcluir: (compra, lancada) => { ... }
 *   });
 *   NotaConferencia.ligarInput(document.getElementById('arquivo-nota'));
 * ===================================================================== */
(function (global) {
  'use strict';

  const cfg = { oficinaId: null, aoConcluir: null };
  let estado = null;
  let raiz = null;

  const moeda = (n) =>
    (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const qtd = (n) =>
    (Number(n) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 4 });
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function configurar(opcoes) { Object.assign(cfg, opcoes || {}); }

  // ------------------------------------------------------------------
  // Mensagens — no padrão da tela, nunca alert() do navegador
  // ------------------------------------------------------------------

  /* Fora do modal: usa a faixa de aviso que a página já tem. */
  function avisarTela(texto, tipo) {
    const alvo = document.getElementById('msg2') || document.getElementById('msg');
    if (alvo && typeof aviso === 'function') {
      aviso(alvo, texto, tipo || 'erro');
      alvo.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (tipo === 'ok') setTimeout(() => aviso(alvo, ''), 5000);
      return;
    }
    console.warn('[nota]', texto);
  }

  /* Dentro do modal: faixa no topo, acima do cabeçalho da nota. */
  function avisarModal(texto, tipo) {
    if (!raiz) return avisarTela(texto, tipo);
    const modal = raiz.querySelector('.nc-modal');
    if (!modal) return avisarTela(texto, tipo);

    let faixa = modal.querySelector('.nc-mensagem');
    if (!faixa) {
      faixa = document.createElement('div');
      faixa.className = 'nc-mensagem';
      modal.querySelector('.nc-topo').insertAdjacentElement('afterend', faixa);
    }
    faixa.className = 'nc-mensagem nc-mensagem-' + (tipo || 'erro');
    faixa.textContent = texto;
    faixa.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  const STATUS = { rascunho: 'está como rascunho', lancada: 'já foi lançada',
                   cancelada: 'foi cancelada' };

  function dataBr(iso) {
    if (!iso) return '';
    const p = String(iso).slice(0, 10).split('-');
    return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : '';
  }

  // ------------------------------------------------------------------
  // Consultas — tudo via Banco (PostgREST direto)
  // ------------------------------------------------------------------
  async function notaJaExiste(chave) {
    if (!chave) return null;
    const r = await Banco.listar('compras',
      `chave_acesso=eq.${chave}&select=id,numero,status,emitida_em&limit=1`);
    return (r && r[0]) || null;
  }

  const listaIn = (valores) =>
    valores.map((c) => '"' + String(c).replace(/"/g, '') + '"').join(',');

  async function resolverVinculos(itens, cnpj) {
    const codigos = itens.map((i) => i.codigoFornecedor).filter(Boolean);

    // 1) de-para aprendido em importações anteriores deste fornecedor
    let dePara = [];
    if (cnpj && codigos.length) {
      dePara = await Banco.listar('fornecedor_peca_codigo',
        `fornecedor_cnpj=eq.${cnpj}&codigo_fornecedor=in.(${listaIn(codigos)})` +
        '&select=codigo_fornecedor,peca_id,fator_conversao,pecas(id,numero,nome,unidade)') || [];
    }

    // 2) código do fornecedor igual ao código cadastrado na peça
    let porCodigo = [];
    if (codigos.length) {
      porCodigo = await Banco.listar('pecas',
        `codigo=in.(${listaIn(codigos)})&ativo=is.true` +
        '&select=id,numero,nome,unidade,codigo') || [];
    }

    itens.forEach((item) => {
      const v = dePara.find((d) => d.codigo_fornecedor === item.codigoFornecedor);
      if (v) {
        const p = Array.isArray(v.pecas) ? v.pecas[0] : v.pecas;
        if (p) {
          item.peca = p;
          item.fatorConversao = Number(v.fator_conversao) || 1;
          item.vinculo = 'codigo';
          return;
        }
      }
      const c = item.codigoFornecedor
        && porCodigo.find((p) => p.codigo === item.codigoFornecedor);
      if (c) { item.peca = c; item.vinculo = 'catalogo'; return; }
      item.peca = null;
      item.vinculo = 'pendente';
    });
    return itens;
  }

  async function buscarPecas(termo) {
    if (!termo || termo.length < 2) return [];
    const t = encodeURIComponent('*' + termo + '*');
    const r = await Banco.listar('pecas',
      `or=(nome.ilike.${t},codigo.ilike.${t},numero.ilike.${t})` +
      '&ativo=is.true&select=id,numero,nome,unidade,saldo&limit=12');
    return r || [];
  }

  async function criarPeca(item) {
    return await Banco.criar('pecas', {
      oficina_id: cfg.oficinaId,
      nome: item.descricao.slice(0, 120),
      codigo: item.codigoFornecedor || null,
      unidade: (item.unidade || 'un').toLowerCase(),
      preco_custo: Number(item.custoUnitario.toFixed(4))
    });
  }

  // ------------------------------------------------------------------
  // Conferência
  // ------------------------------------------------------------------
  function diferenca() {
    const soma = estado.itens.reduce((s, i) => s + i.custoUnitario * i.quantidade, 0);
    return NotaImport.arred((estado.totais.nota || 0) - soma, 2);
  }

  function pendencias() {
    const lista = [];
    if (!estado.itens.length) lista.push('nenhum item');
    const sem = estado.itens.filter((i) => !i.peca).length;
    if (sem) lista.push(`${sem} item(ns) sem peça vinculada`);
    if (Math.abs(diferenca()) > 0.05 && !estado.divergenciaAceita) {
      lista.push(`soma difere do total em ${moeda(Math.abs(diferenca()))}`);
    }
    if (!estado.fornecedorNome) lista.push('fornecedor em branco');
    if (!estado.emissao) lista.push('data de emissão em branco');
    return lista;
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  function linhaItem(item, idx) {
    const rotulo = {
      codigo: 'vinculada pelo código do fornecedor',
      catalogo: 'código igual ao do seu catálogo',
      manual: 'vinculada agora',
      nova: 'peça criada agora',
      pendente: ''
    }[item.vinculo] || '';

    return `
      <tr class="${item.peca ? 'nc-ok' : 'nc-pendente'}" data-idx="${idx}">
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
                 <small>${item.peca.numero ? '#' + esc(item.peca.numero) + ' · ' : ''}${esc(rotulo)}</small>
               </button>`
            : `<input type="text" class="nc-busca" data-acao="buscar"
                      placeholder="buscar peça pelo nome, código ou número" autocomplete="off">
               <div class="nc-sugestoes" hidden></div>
               <button type="button" class="nc-link" data-acao="criar">cadastrar como peça nova</button>`}
        </td>
        <td class="nc-col-num">
          <input type="number" step="0.0001" min="0.0001" class="nc-inp"
                 value="${item.quantidade}" data-campo="quantidade">
          <span class="nc-un">${esc(item.unidade)}</span>
        </td>
        <td class="nc-col-num">
          <input type="number" step="0.0001" min="0.0001" class="nc-inp"
                 value="${item.fatorConversao || 1}" data-campo="fatorConversao"
                 title="Quantas unidades do seu estoque cabem em 1 ${esc(item.unidade)}">
        </td>
        <td class="nc-col-num nc-custo">${moeda(item.custoUnitario)}</td>
        <td class="nc-col-num nc-entra">
          <strong>${qtd(item.quantidade * (item.fatorConversao || 1))}</strong>
        </td>
        <td class="nc-col-acao">
          <button type="button" class="nc-remover" data-acao="remover" title="Remover">×</button>
        </td>
      </tr>`;
  }

  function render() {
    const dif = diferenca();
    const pend = pendencias();

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

          ${estado.confianca.itens === 'baixa' ? `
            <div class="nc-alerta nc-alerta-forte">
              A leitura dos itens ficou incompleta. Complete o que faltar antes de lançar.
            </div>` : ''}

          ${estado.avisos.length ? `
            <ul class="nc-avisos">${estado.avisos.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}

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
              <div class="nc-chave"><span>Chave de acesso</span><code>${esc(estado.chave)}</code></div>` : ''}
          </section>

          <div class="nc-tabela-wrap">
            <table class="nc-tabela">
              <thead>
                <tr>
                  <th>Item da nota</th><th>Peça no seu estoque</th><th>Qtd</th>
                  <th>Fator</th><th>Custo un.</th><th>Entra</th><th></th>
                </tr>
              </thead>
              <tbody>${estado.itens.map(linhaItem).join('')}</tbody>
            </table>
          </div>

          <section class="nc-totais">
            <div>
              <span>Soma dos itens</span>
              <strong>${moeda(estado.itens.reduce((s, i) => s + i.custoUnitario * i.quantidade, 0))}</strong>
            </div>
            <div><span>Total da nota</span><strong>${moeda(estado.totais.nota)}</strong></div>
            <div class="${Math.abs(dif) > 0.05 ? 'nc-dif' : 'nc-dif-ok'}">
              <span>Diferença</span><strong>${moeda(dif)}</strong>
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
              <button type="button" class="nc-btn" data-acao="rascunho"
                      ${estado.itens.some((i) => !i.peca) ? 'disabled' : ''}>Salvar rascunho</button>
              <button type="button" class="nc-btn nc-btn-primario"
                      data-acao="lancar" ${pend.length ? 'disabled' : ''}>Lançar no estoque</button>
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

    const aceita = raiz.querySelector('#nc-aceita');
    if (aceita) aceita.addEventListener('change', (e) => {
      estado.divergenciaAceita = e.target.checked;
      render();
    });

    [['fornecedor', 'fornecedorNome'], ['numero', 'numero'],
     ['serie', 'serie'], ['emissao', 'emissao']].forEach(([id, campo]) => {
      const el = raiz.querySelector('#nc-' + id);
      if (el) el.addEventListener('change', () => { estado[campo] = el.value; });
    });

    modal.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-acao]');
      if (!btn) return;
      const tr = btn.closest('tr');
      const idx = tr ? Number(tr.dataset.idx) : -1;

      switch (btn.dataset.acao) {
        case 'fechar':  return fechar();
        case 'remover': estado.itens.splice(idx, 1); return render();
        case 'trocar':
          estado.itens[idx].peca = null;
          estado.itens[idx].vinculo = 'pendente';
          return render();
        case 'criar':
          btn.disabled = true;
          try {
            estado.itens[idx].peca = await criarPeca(estado.itens[idx]);
            estado.itens[idx].vinculo = 'nova';
            render();
          } catch (e) {
            avisarModal('Não foi possível cadastrar a peça: ' + e.message);
            btn.disabled = false;
          }
          return;
        case 'rascunho': return salvar(false, btn);
        case 'lancar':   return salvar(true, btn);
      }
    });

    modal.querySelectorAll('.nc-busca').forEach((input) => {
      let timer;
      const caixa = input.parentElement.querySelector('.nc-sugestoes');
      const idx = Number(input.closest('tr').dataset.idx);

      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          let lista = [];
          try { lista = await buscarPecas(input.value.trim()); } catch (e) { return; }
          if (!lista.length) { caixa.hidden = true; return; }
          caixa.innerHTML = lista.map((p) =>
            `<button type="button" data-id="${p.id}">
               <span>${esc(p.nome)}</span>
               <small>${p.numero ? '#' + esc(p.numero) + ' · ' : ''}saldo ${qtd(p.saldo)}</small>
             </button>`).join('');
          caixa.hidden = false;
          // mousedown, e não click: o blur do input fecharia a caixa antes
          caixa.querySelectorAll('button').forEach((b) =>
            b.addEventListener('mousedown', () => {
              estado.itens[idx].peca = lista.find((x) => x.id === b.dataset.id);
              estado.itens[idx].vinculo = 'manual';
              render();
            }));
        }, 280);
      });
      input.addEventListener('blur', () => setTimeout(() => { caixa.hidden = true; }, 200));
    });

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
  // Arquivo original no Storage (comprovante para a contabilidade)
  // ------------------------------------------------------------------
  async function enviarArquivo(compraId) {
    if (!estado.arquivo) return null;
    try {
      const token = await Sessao.token();
      if (!token) return null;
      const ext = estado.origem === 'xml' ? 'xml' : 'pdf';
      const caminho = `${cfg.oficinaId}/${compraId}.${ext}`;
      const r = await fetch(
        `${VEXOS.url}/storage/v1/object/notas-fiscais/${caminho}`, {
          method: 'POST',
          headers: {
            apikey: VEXOS.chave,
            Authorization: 'Bearer ' + token,
            'x-upsert': 'true'
          },
          body: estado.arquivo
        });
      return r.ok ? caminho : null;
    } catch (e) {
      return null;  // desejável, não obrigatório
    }
  }

  // ------------------------------------------------------------------
  // Gravação
  // ------------------------------------------------------------------
  async function salvar(lancar, botao) {
    const textoOriginal = botao.textContent;
    botao.disabled = true;
    botao.textContent = lancar ? 'Lançando…' : 'Salvando…';

    let compra = null;
    try {
      compra = await Banco.criar('compras', {
        oficina_id: cfg.oficinaId,
        fornecedor: estado.fornecedorNome || null,
        fornecedor_cnpj: estado.fornecedorCnpj || null,
        numero: estado.numero || null,
        serie: estado.serie || null,
        chave_acesso: estado.chave || null,
        emitida_em: estado.emissao || null,
        origem: estado.origem,
        valor_produtos: estado.totais.produtos || null,
        valor_frete: estado.totais.frete || null,
        valor_desconto: estado.totais.desconto || null,
        valor_ipi: estado.totais.ipi || null,
        valor_st: estado.totais.st || null,
        valor_total: estado.totais.nota || null
      });

      for (let i = 0; i < estado.itens.length; i++) {
        const it = estado.itens[i];
        const fator = it.fatorConversao || 1;
        await Banco.criar('compra_itens', {
          compra_id: compra.id,
          peca_id: it.peca.id,
          // quantidade e custo já convertidos para a unidade do seu estoque
          quantidade: Number((it.quantidade * fator).toFixed(4)),
          custo_unit: Number((it.custoUnitario / fator).toFixed(4)),
          ordem: i
        });
      }

      // de-para, para as próximas notas deste fornecedor
      if (estado.fornecedorCnpj) {
        const vinculos = estado.itens
          .filter((i) => i.peca && i.codigoFornecedor)
          .map((i) => ({
            oficina_id: cfg.oficinaId,
            fornecedor_cnpj: estado.fornecedorCnpj,
            codigo_fornecedor: i.codigoFornecedor,
            peca_id: i.peca.id,
            unidade_comercial: i.unidade || null,
            fator_conversao: i.fatorConversao || 1,
            descricao_origem: i.descricao,
            atualizado_em: new Date().toISOString()
          }));
        if (vinculos.length) {
          try {
            await Banco.pedir('/rest/v1/fornecedor_peca_codigo', {
              metodo: 'POST',
              corpo: vinculos,
              headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }
            });
          } catch (e) { /* conveniência: não trava o lançamento */ }
        }
      }

      const caminho = await enviarArquivo(compra.id);
      if (caminho) {
        try { await Banco.atualizar('compras', compra.id, { arquivo_path: caminho }); }
        catch (e) {}
      }

      if (lancar) {
        await Banco.chamar('lancar_compra', { p_compra_id: compra.id });
      }

      fechar();
      if (typeof cfg.aoConcluir === 'function') cfg.aoConcluir(compra, lancar);
    } catch (e) {
      const dup = /duplicate key|compras_chave_uk/i.test(e.message || '');
      avisarModal(dup
        ? 'Esta nota já está no sistema. Feche e procure pelo número na lista.'
        : (lancar ? 'Não foi possível lançar: ' : 'Não foi possível salvar: ')
          + e.message
          + (compra ? ' A nota ficou salva como rascunho e aparece na lista.' : ''));
      botao.disabled = false;
      botao.textContent = textoOriginal;
    }
  }

  // ------------------------------------------------------------------
  // Abertura
  // ------------------------------------------------------------------
  async function abrir(nota, arquivo) {
    if (!cfg.oficinaId) throw new Error('NotaConferencia.configurar() não foi chamado.');

    if (nota.chave) {
      const jaTem = await notaJaExiste(nota.chave);
      if (jaTem) {
        const emissao = dataBr(jaTem.emitida_em);
        avisarTela(
          `A nota ${jaTem.numero || 'sem número'}` +
          (nota.fornecedor.nome ? ` de ${nota.fornecedor.nome}` : '') +
          (emissao ? `, emitida em ${emissao},` : '') +
          ` ${STATUS[jaTem.status] || 'já está no sistema'}. ` +
          'Nada foi importado — procure por ela na lista de notas.',
          'info');
        return;
      }
    }

    const itens = await resolverVinculos(
      nota.itens.map((i) => Object.assign({}, i)), nota.fornecedor.cnpj);

    itens.forEach((i) => {
      if (!i.fatorConversao || i.fatorConversao === 1) {
        i.fatorConversao = (i.fatorSugerido && i.fatorSugerido > 1) ? i.fatorSugerido : 1;
      }
    });

    estado = {
      origem: nota.origem,
      chave: nota.chave || '',
      numero: nota.numero || '',
      serie: nota.serie || '',
      emissao: nota.emissao || new Date().toISOString().slice(0, 10),
      fornecedorCnpj: nota.fornecedor.cnpj || '',
      fornecedorNome: nota.fornecedor.nome || '',
      totais: nota.totais,
      confianca: nota.confianca,
      avisos: (nota.avisos || []).slice(),
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

  function ligarInput(input, aoErro) {
    input.addEventListener('change', async () => {
      const arquivos = Array.from(input.files || []);
      if (!arquivos.length) return;
      try {
        const { notas, erros } = await NotaImport.ler(arquivos);
        if (erros.length && typeof aoErro === 'function') aoErro(erros);
        if (notas.length) {
          const n = notas[0];
          await abrir(n, arquivos.find((a) => a.name === n.arquivoNome) || arquivos[0]);
          if (notas.length > 1) {
            console.info(`${notas.length - 1} nota(s) restante(s) — importe uma por vez.`);
          }
        } else {
          avisarTela('Não consegui ler o arquivo' +
                     (erros.length ? ': ' + erros[0].mensagem : '.'));
        }
      } catch (e) {
        avisarTela('Não consegui ler o arquivo: ' + e.message);
      } finally {
        input.value = '';
      }
    });
  }

  global.NotaConferencia = { configurar, abrir, ligarInput, fechar };
})(window);

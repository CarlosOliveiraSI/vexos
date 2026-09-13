/* =====================================================================
 * VexOS — nota-import.js
 * Leitura de nota de compra a partir de XML da NFe, DANFE em PDF ou ZIP.
 * Sem dependência do resto do app: devolve sempre a mesma estrutura.
 *
 * Dependências (só carregam quando usadas):
 *   pdf.js  → window.pdfjsLib   (PDF)
 *   jsQR    → window.jsQR       (QR Code do DANFE)
 *   JSZip   → window.JSZip      (arquivos .zip)
 *
 * Uso:
 *   const r = await NotaImport.ler(file);
 *   r.notas[0]  →  objeto normalizado (ver formato no fim do arquivo)
 * ===================================================================== */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // Utilidades
  // ------------------------------------------------------------------
  const semAcento = (s) =>
    (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

  const soDigitos = (s) => (s || '').replace(/\D/g, '');

  /** "1.234,56" ou "1234.56" → 1234.56 */
  function numeroBr(txt) {
    if (txt == null) return 0;
    let s = String(txt).trim().replace(/\s/g, '');
    if (!s) return 0;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s.replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  }

  const arred = (n, casas = 2) => {
    const f = Math.pow(10, casas);
    return Math.round((n + Number.EPSILON) * f) / f;
  };

  /** Dígito verificador da chave de acesso (módulo 11). */
  function chaveValida(chave) {
    if (!/^\d{44}$/.test(chave || '')) return false;
    const base = chave.slice(0, 43);
    let peso = 2, soma = 0;
    for (let i = base.length - 1; i >= 0; i--) {
      soma += parseInt(base[i], 10) * peso;
      peso = peso === 9 ? 2 : peso + 1;
    }
    const resto = soma % 11;
    const dv = resto < 2 ? 0 : 11 - resto;
    return dv === parseInt(chave[43], 10);
  }

  /**
   * A chave já carrega CNPJ, série, número e mês/ano de emissão.
   * cUF(2) AAMM(4) CNPJ(14) mod(2) serie(3) nNF(9) tpEmis(1) cNF(8) cDV(1)
   */
  function dadosDaChave(chave) {
    if (!/^\d{44}$/.test(chave || '')) return null;
    const ano = 2000 + parseInt(chave.slice(2, 4), 10);
    const mes = chave.slice(4, 6);
    return {
      cnpj: chave.slice(6, 20),
      modelo: chave.slice(20, 22),
      serie: String(parseInt(chave.slice(22, 25), 10)),
      numero: String(parseInt(chave.slice(25, 34), 10)),
      competencia: `${ano}-${mes}`
    };
  }

  // Códigos de UF do IBGE — os dois primeiros dígitos da chave
  const UFS = ['11','12','13','14','15','16','17','21','22','23','24','25','26',
               '27','28','29','31','32','33','35','41','42','43','50','51','52','53'];

  /**
   * Além do dígito verificador, confere se a chave faz sentido: UF existente,
   * mês entre 01 e 12, modelo 55 (NF-e) ou 65 (NFC-e). Sozinho, o módulo 11
   * aceita 1 em cada 11 sequências — pouco para varrer um documento inteiro
   * atrás de 44 dígitos.
   */
  function chavePlausivel(chave) {
    if (!chaveValida(chave)) return false;
    if (UFS.indexOf(chave.slice(0, 2)) === -1) return false;
    const mes = parseInt(chave.slice(4, 6), 10);
    if (!(mes >= 1 && mes <= 12)) return false;
    const modelo = chave.slice(20, 22);
    if (modelo !== '55' && modelo !== '65') return false;
    return true;
  }

  /**
   * Procura a chave em qualquer ponto de uma sequência de dígitos,
   * deslizando uma janela de 44 — no DANFE ela costuma vir grudada ao
   * número da nota na mesma linha, então exigir a linha inteira com
   * exatamente 44 dígitos não funciona.
   */
  function acharChave(digitos) {
    if (!digitos || digitos.length < 44) return '';
    for (let i = 0; i + 44 <= digitos.length; i++) {
      const candidata = digitos.substr(i, 44);
      if (chavePlausivel(candidata)) return candidata;
    }
    return '';
  }

  function carregarScript(url) {
    return new Promise((ok, erro) => {
      if (document.querySelector(`script[src="${url}"]`)) return ok();
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => ok();
      s.onerror = () => erro(new Error('Não foi possível carregar ' + url));
      document.head.appendChild(s);
    });
  }

  const CDN = {
    pdf: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    jsqr: 'https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js',
    jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
  };

  // ------------------------------------------------------------------
  // Rateio de frete/seguro/desconto/outros quando só vêm no total
  // ------------------------------------------------------------------
  function ratear(itens, totais) {
    const campos = ['frete', 'seguro', 'desconto', 'outros'];
    const baseProdutos = itens.reduce((s, i) => s + i.valorProdutos, 0);
    if (baseProdutos <= 0) return;

    campos.forEach((c) => {
      const somaItens = itens.reduce((s, i) => s + i[c], 0);
      const totalDoc = totais[c] || 0;
      if (somaItens > 0.009 || totalDoc <= 0.009) return;
      let acumulado = 0;
      itens.forEach((item, idx) => {
        let parte = idx === itens.length - 1
          ? arred(totalDoc - acumulado)
          : arred((item.valorProdutos / baseProdutos) * totalDoc);
        acumulado += parte;
        item[c] = parte;
      });
    });
  }

  function calcularCusto(item) {
    const bruto =
      item.valorProdutos + item.ipi + item.st +
      item.frete + item.seguro + item.outros - item.desconto;
    item.custoUnitario = item.quantidade > 0 ? arred(bruto / item.quantidade, 6) : 0;
    return item;
  }

  function itemVazio() {
    return {
      ordem: 1, codigoFornecedor: '', ean: '', descricao: '', ncm: '', cfop: '',
      unidade: 'UN', quantidade: 0, valorUnitario: 0, valorProdutos: 0,
      frete: 0, seguro: 0, desconto: 0, outros: 0, ipi: 0, st: 0,
      custoUnitario: 0, fatorConversao: 1
    };
  }

  // ==================================================================
  // XML da NFe (4.00 e 3.10)
  // ==================================================================
  function lerXmlTexto(texto, nomeArquivo) {
    const doc = new DOMParser().parseFromString(texto, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('Arquivo XML inválido ou corrompido.');
    }

    // getElementsByTagNameNS('*') ignora prefixo e namespace do emissor
    const filhos = (el, nome) =>
      el ? Array.from(el.getElementsByTagNameNS('*', nome)) : [];
    const filho = (el, nome) => filhos(el, nome)[0] || null;
    const txt = (el, nome) => { const n = filho(el, nome); return n ? n.textContent.trim() : ''; };
    const val = (el, nome) => numeroBr(txt(el, nome));

    const infNFe = filho(doc, 'infNFe');
    if (!infNFe) {
      throw new Error('Este XML não é uma NFe (elemento infNFe não encontrado).');
    }

    const avisos = [];
    const chave = soDigitos(infNFe.getAttribute('Id') || '').slice(-44);
    if (chave && !chavePlausivel(chave)) avisos.push('A chave de acesso não passou na validação do dígito verificador.');

    const ide = filho(infNFe, 'ide');
    const emit = filho(infNFe, 'emit');
    const total = filho(infNFe, 'ICMSTot');

    const modelo = txt(ide, 'mod');
    if (modelo && modelo !== '55') {
      avisos.push(`Modelo ${modelo} — esperado 55 (NF-e). Confira os dados antes de lançar.`);
    }

    const dh = txt(ide, 'dhEmi') || txt(ide, 'dEmi');
    const emissao = dh ? dh.slice(0, 10) : '';

    const totais = {
      produtos: val(total, 'vProd'),
      frete: val(total, 'vFrete'),
      seguro: val(total, 'vSeg'),
      desconto: val(total, 'vDesc'),
      outros: val(total, 'vOutro'),
      ipi: val(total, 'vIPI'),
      st: val(total, 'vST'),
      nota: val(total, 'vNF')
    };

    const itens = filhos(infNFe, 'det').map((det, idx) => {
      const prod = filho(det, 'prod');
      const imposto = filho(det, 'imposto');

      const item = itemVazio();
      item.ordem = parseInt(det.getAttribute('nItem') || idx + 1, 10);
      item.codigoFornecedor = txt(prod, 'cProd');
      const ean = txt(prod, 'cEAN');
      item.ean = /^\d{8,14}$/.test(ean) ? ean : '';
      item.descricao = txt(prod, 'xProd');
      item.ncm = txt(prod, 'NCM');
      item.cfop = txt(prod, 'CFOP');
      item.unidade = txt(prod, 'uCom') || 'UN';
      item.quantidade = val(prod, 'qCom');
      item.valorUnitario = val(prod, 'vUnCom');
      item.valorProdutos = val(prod, 'vProd');
      item.frete = val(prod, 'vFrete');
      item.seguro = val(prod, 'vSeg');
      item.desconto = val(prod, 'vDesc');
      item.outros = val(prod, 'vOutro');

      // vProd entra no total da nota? (indTot = 0 significa que não)
      if (txt(prod, 'indTot') === '0') item.somaNoTotal = false;

      if (imposto) {
        item.ipi = val(filho(imposto, 'IPITrib') || imposto, 'vIPI');
        item.st = numeroBr(txt(imposto, 'vICMSST')) + numeroBr(txt(imposto, 'vFCPST'));
      }

      // unidade tributável diferente da comercial: registra o aviso
      const uTrib = txt(prod, 'uTrib');
      const qTrib = val(prod, 'qTrib');
      if (uTrib && uTrib !== item.unidade && qTrib > 0) {
        item.unidadeTributavel = uTrib;
        item.fatorSugerido = arred(qTrib / item.quantidade, 4);
      }
      return item;
    });

    if (!itens.length) throw new Error('O XML não tem itens.');

    ratear(itens, totais);
    itens.forEach(calcularCusto);

    return {
      origem: 'xml',
      arquivoNome: nomeArquivo,
      confianca: { cabecalho: 'alta', itens: 'alta' },
      chave,
      numero: txt(ide, 'nNF'),
      serie: txt(ide, 'serie'),
      emissao,
      fornecedor: {
        cnpj: soDigitos(txt(emit, 'CNPJ') || txt(emit, 'CPF')),
        nome: txt(emit, 'xNome'),
        fantasia: txt(emit, 'xFant'),
        ie: txt(emit, 'IE')
      },
      totais,
      itens,
      avisos,
      xmlTexto: texto
    };
  }

  // ==================================================================
  // DANFE em PDF
  // ==================================================================
  async function prepararPdfJs() {
    if (!global.pdfjsLib) await carregarScript(CDN.pdf);
    if (global.pdfjsLib && !global.pdfjsLib.GlobalWorkerOptions.workerSrc) {
      global.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
    }
  }

  /** Agrupa os tokens de texto da página em linhas, pela coordenada Y. */
  function montarLinhas(tokens) {
    const tol = 3;
    const linhas = [];
    tokens
      .slice()
      .sort((a, b) => (b.y - a.y) || (a.x - b.x))
      .forEach((t) => {
        const alvo = linhas.find((l) => Math.abs(l.y - t.y) <= tol);
        if (alvo) { alvo.tokens.push(t); alvo.y = (alvo.y + t.y) / 2; }
        else linhas.push({ y: t.y, tokens: [t] });
      });
    linhas.forEach((l) => {
      l.tokens.sort((a, b) => a.x - b.x);
      l.texto = l.tokens.map((t) => t.str).join(' ').replace(/\s+/g, ' ').trim();
    });
    return linhas;
  }

  /** Lê a chave de acesso pelo QR Code impresso no DANFE (funciona em digitalizado). */
  async function chavePeloQr(pagina) {
    if (!global.jsQR) {
      try { await carregarScript(CDN.jsqr); } catch (e) { return ''; }
    }
    if (!global.jsQR) return '';
    try {
      const viewport = pagina.getViewport({ scale: 2.5 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      await pagina.render({ canvasContext: ctx, viewport }).promise;
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const qr = global.jsQR(img.data, img.width, img.height);
      if (!qr || !qr.data) return '';
      const m = qr.data.match(/(?:chNFe=|[?&]p=)(\d{44})/i) || qr.data.match(/(\d{44})/);
      return m ? m[1] : '';
    } catch (e) {
      return '';
    }
  }

  /* Cada emissor escreve o cabeçalho do DANFE de um jeito: QTD., QUANT.,
     VLR UNIT., VALOR UNITÁRIO. Os regexes cobrem as formas que aparecem
     na prática. */
  const ROTULOS_COLUNA = [
    { chave: 'codigo',        regex: /^C[ÓO]D(IGO)?/ },
    { chave: 'descricao',     regex: /^DESCRI/ },
    { chave: 'ncm',           regex: /^NCM/ },
    { chave: 'cst',           regex: /^(CST|CSOSN|O\/?CST)/ },
    { chave: 'cfop',          regex: /^CFOP/ },
    { chave: 'unidade',       regex: /^(UNID|UN)\.?$|^UNIDADE/ },
    { chave: 'quantidade',    regex: /^(QTD|QTDE|QUANT)/ },
    { chave: 'valorUnitario', regex: /^(VLR|V\.|VALOR)?\s*UNIT|^UNIT[ÁA]RIO/ },
    { chave: 'valorTotal',    regex: /^(VLR|V\.|VALOR)?\s*TOTAL/ }
  ];

  /**
   * Encontra a faixa da tabela de produtos e converte as linhas em itens,
   * usando a posição X dos rótulos do cabeçalho como limite de coluna.
   */
  /**
   * Encontra a faixa da tabela de produtos e converte as linhas em itens.
   *
   * Duas coisas tornam isso menos trivial do que parece. Primeiro, TODOS os
   * tokens do cabeçalho viram fronteira de coluna, inclusive os que não
   * interessam (B. CALC. ICMS, ALÍQUOTAS): sem isso a última coluna útil
   * engole todos os números à direita dela. Segundo, a descrição costuma
   * vir em linha própria, às vezes acima da linha de valores, às vezes
   * abaixo — por isso a classificação em duas passadas.
   */
  function extrairItensPdf(linhas, avisos) {
    const idxCab = linhas.findIndex((l) => {
      const t = semAcento(l.texto);
      return /C[OÓ]DIGO/.test(t) && /DESCRI/.test(t) && /(QTD|QUANT|NCM)/.test(t);
    });
    if (idxCab === -1) {
      avisos.push('Não encontrei a tabela de produtos neste PDF. Preencha os itens manualmente.');
      return { itens: [], confianca: 'baixa' };
    }

    // Toda posição do cabeçalho é fronteira; só algumas têm nome útil.
    const colunas = [];
    linhas[idxCab].tokens.forEach((tok, i) => {
      const t = semAcento(tok.str).trim();
      if (!t) return;
      const achou = ROTULOS_COLUNA.find((r) => r.regex.test(t));
      const chave = (achou && !colunas.some((c) => c.chave === achou.chave))
        ? achou.chave
        : '_' + i;
      colunas.push({ chave: chave, x: tok.x });
    });
    colunas.sort((a, b) => a.x - b.x);

    const temColuna = (c) => colunas.some((x) => x.chave === c);
    if (!temColuna('quantidade')) {
      avisos.push('O cabeçalho da tabela não traz a coluna de quantidade. Confira item por item.');
    }

    const limite = (i) => (i < colunas.length - 1 ? colunas[i + 1].x - 4 : Infinity);
    const colunaDoToken = (tok) => {
      const centro = tok.x + (tok.w || 0) / 2;
      for (let i = 0; i < colunas.length; i++) {
        if (centro >= colunas[i].x - 12 && centro < limite(i)) return colunas[i].chave;
      }
      return colunas.length ? colunas[0].chave : 'descricao';
    };

    const FIM = /(DADOS ADICIONAIS|INFORMA[CÇ][OÕ]ES COMPLEMENTARES|C[AÁ]LCULO DO ISSQN|RESERVADO AO FISCO)/;

    // --- passada 1: classifica cada linha em ITEM ou FRAGMENTO ------------
    const brutas = [];
    for (let i = idxCab + 1; i < linhas.length; i++) {
      const linha = linhas[i];
      const texto = semAcento(linha.texto);
      if (!texto) continue;
      if (FIM.test(texto)) break;

      // segunda linha do próprio cabeçalho (PRODUTO / ICMS / IPI soltos)
      if (/^(PRODUTO|SERVICOS|ICMS|IPI)(\s+(ICMS|IPI|PRODUTO|SERVICOS))*$/.test(texto)) continue;

      const celulas = {};
      linha.tokens.forEach((tok) => {
        const c = colunaDoToken(tok);
        celulas[c] = (celulas[c] ? celulas[c] + ' ' : '') + tok.str.trim();
      });

      const temCodigo = (celulas.codigo || '').trim().length > 0;
      const temNumeros = numeroBr(celulas.quantidade) > 0
        || numeroBr(celulas.valorUnitario) > 0
        || numeroBr(celulas.valorTotal) > 0;

      brutas.push({
        tipo: (temCodigo || temNumeros) ? 'item' : 'fragmento',
        celulas: celulas,
        texto: (celulas.descricao || linha.texto).trim()
      });
    }

    // --- passada 2: fragmentos vão para o item que vem depois; se não
    //     houver, para o item anterior --------------------------------------
    const itens = [];
    let pendentes = [];
    let parciais = 0;

    brutas.forEach((linha, i) => {
      if (linha.tipo === 'fragmento') {
        const proximoItem = brutas.slice(i + 1).find((b) => b.tipo === 'item');
        if (proximoItem) pendentes.push(linha.texto);
        else if (itens.length) itens[itens.length - 1].descricao += ' ' + linha.texto;
        return;
      }

      const c = linha.celulas;
      const item = itemVazio();
      item.ordem = itens.length + 1;
      item.codigoFornecedor = (c.codigo || '').replace(/\s+/g, '');
      item.descricao = [pendentes.join(' '), (c.descricao || '').trim()]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      pendentes = [];

      item.ncm = soDigitos(c.ncm || '').slice(0, 8);
      item.cfop = soDigitos(c.cfop || '').slice(0, 4);
      item.unidade = (c.unidade || 'UN').replace(/[^A-Za-z]/g, '').toUpperCase() || 'UN';
      item.quantidade = numeroBr(c.quantidade);
      item.valorUnitario = numeroBr(c.valorUnitario);
      item.valorProdutos = numeroBr(c.valorTotal);

      // completa o que faltar a partir dos outros dois
      if (!item.valorProdutos && item.quantidade && item.valorUnitario) {
        item.valorProdutos = arred(item.quantidade * item.valorUnitario);
      }
      if (!item.quantidade && item.valorProdutos && item.valorUnitario) {
        item.quantidade = arred(item.valorProdutos / item.valorUnitario, 4);
      }
      if (!item.valorUnitario && item.valorProdutos && item.quantidade) {
        item.valorUnitario = arred(item.valorProdutos / item.quantidade, 6);
      }

      if (!item.quantidade || !item.descricao) parciais++;
      if (item.quantidade > 0) itens.push(item);
    });

    // sobrou descrição sem item nenhum
    if (pendentes.length && itens.length) {
      itens[itens.length - 1].descricao += ' ' + pendentes.join(' ');
    }

    if (!itens.length) {
      avisos.push('Li o PDF mas não consegui separar os itens. Preencha manualmente.');
      return { itens: [], confianca: 'baixa' };
    }
    if (parciais) {
      avisos.push(parciais + ' linha(s) saíram incompletas da leitura do PDF.');
    }
    return { itens: itens, confianca: parciais ? 'baixa' : 'media' };
  }

  /**
   * No DANFE os rótulos ficam numa linha e os valores na de baixo, alinhados
   * por coluna. Lê "VALOR TOTAL DA NOTA" por posição, e não por proximidade
   * no texto corrido — que erra quando há oito números na mesma faixa.
   */
  function totaisPorColuna(linhas) {
    const ALVOS = [
      { chave: 'produtos', regex: /VALOR TOTAL DOS PRODUTOS/ },
      { chave: 'frete',    regex: /VALOR DO FRETE/ },
      { chave: 'seguro',   regex: /VALOR DO SEGURO/ },
      { chave: 'desconto', regex: /^DESCONTO/ },
      { chave: 'outros',   regex: /OUTRAS DESPESAS/ },
      { chave: 'ipi',      regex: /VALOR DO IPI/ },
      { chave: 'st',       regex: /VALOR DO ICMS SUBSTITUI/ },
      { chave: 'nota',     regex: /VALOR TOTAL DA NOTA/ }
    ];
    const achados = {};

    linhas.forEach((linha, i) => {
      const rotulos = linha.tokens
        .map((t) => ({ x: t.x, w: t.w || 0, texto: semAcento(t.str).trim() }))
        .filter((t) => t.texto);
      if (!rotulos.some((r) => ALVOS.some((a) => a.regex.test(r.texto)))) return;

      // primeira linha abaixo com pelo menos dois números
      let valores = null;
      for (let j = i + 1; j < Math.min(linhas.length, i + 3); j++) {
        const nums = linhas[j].tokens.filter((t) => /^[\d.,]+$/.test(t.str.trim()));
        if (nums.length >= 2) { valores = nums; break; }
      }
      if (!valores) return;

      rotulos.forEach((rot, k) => {
        const alvo = ALVOS.find((a) => a.regex.test(rot.texto));
        if (!alvo || achados[alvo.chave] != null) return;
        const inicio = rot.x - 10;
        const fim = k < rotulos.length - 1 ? rotulos[k + 1].x - 10 : Infinity;
        const valor = valores.find((v) => {
          const centro = v.x + (v.w || 0) / 2;
          return centro >= inicio && centro < fim;
        });
        if (valor) achados[alvo.chave] = numeroBr(valor.str);
      });
    });

    return achados;
  }

  async function lerPdf(file) {
    await prepararPdfJs();
    const buffer = await file.arrayBuffer();
    const pdf = await global.pdfjsLib.getDocument({ data: buffer }).promise;

    let tokens = [];
    const pagina1 = await pdf.getPage(1);
    for (let p = 1; p <= pdf.numPages; p++) {
      const pagina = p === 1 ? pagina1 : await pdf.getPage(p);
      const conteudo = await pagina.getTextContent();
      const offset = (p - 1) * 100000; // mantém a ordem entre páginas
      tokens = tokens.concat(
        conteudo.items
          .filter((it) => it.str && it.str.trim())
          .map((it) => ({
            str: it.str,
            x: it.transform[4],
            y: it.transform[5] - offset,
            w: it.width || 0
          }))
      );
    }

    const avisos = [];
    const linhas = montarLinhas(tokens);
    const textoPlano = linhas.map((l) => l.texto).join('\n');
    const semAcentoPlano = semAcento(textoPlano);

    if (!tokens.length) {
      avisos.push('O PDF não tem texto — provavelmente é digitalizado. Só a chave do QR Code pôde ser lida.');
    }

    // 1) chave pelo QR Code (mais confiável), 2) pelo texto
    let chave = await chavePeloQr(pagina1);
    let origemChave = chave ? 'qr' : '';
    if (!chave) {
      // linha a linha primeiro: menos ruído que o documento inteiro
      for (const l of linhas) {
        const achada = acharChave(soDigitos(l.texto));
        if (achada) { chave = achada; origemChave = 'texto'; break; }
      }
    }
    if (!chave) {
      chave = acharChave(soDigitos(textoPlano));
      if (chave) origemChave = 'texto';
    }

    const daChave = dadosDaChave(chave);

    // Número e série: da chave quando houver, senão pelos rótulos do DANFE
    let numero = daChave ? daChave.numero : '';
    let serie = daChave ? daChave.serie : '';
    if (!numero) {
      const m = semAcentoPlano.match(/N[º°O.]?\s*:?\s*((?:\d{3}\.){2}\d{3}|\d{4,9})/);
      if (m) numero = String(parseInt(soDigitos(m[1]), 10));
    }
    if (!serie) {
      const m = semAcentoPlano.match(/S[EÉ]RIE\s*:?\s*(\d{1,3})/);
      if (m) serie = String(parseInt(m[1], 10));
    }

    // Data de emissão
    let emissao = '';
    const mData = semAcentoPlano.match(/DATA DA EMISS[AÃ]O[\s\S]{0,40}?(\d{2}\/\d{2}\/\d{4})/)
      || semAcentoPlano.match(/(\d{2}\/\d{2}\/\d{4})/);
    if (mData) {
      const [d, m2, a] = mData[1].split('/');
      emissao = `${a}-${m2}-${d}`;
    }

    // Fornecedor
    const cnpj = daChave ? daChave.cnpj : (() => {
      const m = textoPlano.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
      return m ? soDigitos(m[0]) : '';
    })();
    /* O canhoto do DANFE começa com "RECEBEMOS DE <emitente> OS PRODUTOS
       CONSTANTES...". É a única ocorrência do nome em posição previsível —
       o bloco do emitente varia demais de layout para layout. */
    let nome = '';
    const mNome = semAcentoPlano.match(/RECEBEMOS DE\s+(.+?)\s+OS PRODUTOS/);
    if (mNome) {
      // recupera o texto original (com acentos) pela posição equivalente
      const bruto = textoPlano.match(/RECEBEMOS DE\s+(.+?)\s+OS PRODUTOS/i);
      nome = ((bruto && bruto[1]) || mNome[1]).trim();
    }
    if (!nome) {
      const idxIdent = linhas.findIndex((l) => /IDENTIFICA/.test(semAcento(l.texto)));
      for (let i = 0; i < Math.min(linhas.length, idxIdent > 0 ? idxIdent : 12); i++) {
        const t = linhas[i].texto.trim();
        if (t.length > 5 && !/^\d/.test(t)
            && !/DANFE|DOCUMENTO AUXILIAR|NOTA FISCAL|RECEBEMOS/.test(semAcento(t))) {
          nome = t; break;
        }
      }
    }

    // Totais: por posição de coluna; texto corrido só como reserva
    const pegar = (rotulo) => {
      const re = new RegExp(rotulo + '[\\s\\S]{0,60}?(\\d{1,3}(?:\\.\\d{3})*,\\d{2})');
      const m = semAcentoPlano.match(re);
      return m ? numeroBr(m[1]) : 0;
    };
    const porColuna = totaisPorColuna(linhas);
    const valorDe = (chave, rotulo) =>
      porColuna[chave] != null ? porColuna[chave] : pegar(rotulo);

    const totais = {
      produtos: valorDe('produtos', 'VALOR TOTAL DOS PRODUTOS'),
      frete:    valorDe('frete',    'VALOR DO FRETE'),
      seguro:   valorDe('seguro',   'VALOR DO SEGURO'),
      desconto: valorDe('desconto', 'DESCONTO'),
      outros:   valorDe('outros',   'OUTRAS DESPESAS'),
      ipi:      valorDe('ipi',      'VALOR DO IPI'),
      st:       valorDe('st',       'VALOR DO ICMS SUBSTITUI'),
      nota:     valorDe('nota',     'VALOR TOTAL DA NOTA')
    };
    if (!totais.nota && totais.produtos) totais.nota = totais.produtos;

    const { itens, confianca } = extrairItensPdf(linhas, avisos);
    if (itens.length) {
      if (!totais.produtos) totais.produtos = arred(itens.reduce((s, i) => s + i.valorProdutos, 0));
      ratear(itens, totais);
      itens.forEach(calcularCusto);
    }

    avisos.unshift(
      origemChave === 'qr'
        ? 'Chave de acesso lida do QR Code do DANFE.'
        : 'PDF é representação da nota — confira os itens antes de lançar.'
    );

    return {
      origem: 'pdf',
      arquivoNome: file.name,
      confianca: { cabecalho: chave ? 'alta' : 'media', itens: confianca },
      chave,
      numero,
      serie,
      emissao,
      fornecedor: { cnpj, nome, fantasia: '', ie: '' },
      totais,
      itens,
      avisos
    };
  }

  // ==================================================================
  // Entrada única
  // ==================================================================
  async function lerArquivo(file) {
    const nome = (file.name || '').toLowerCase();
    if (nome.endsWith('.xml') || file.type === 'text/xml' || file.type === 'application/xml') {
      return [lerXmlTexto(await file.text(), file.name)];
    }
    if (nome.endsWith('.pdf') || file.type === 'application/pdf') {
      return [await lerPdf(file)];
    }
    if (nome.endsWith('.zip')) {
      if (!global.JSZip) await carregarScript(CDN.jszip);
      const zip = await global.JSZip.loadAsync(await file.arrayBuffer());
      const saida = [];
      const nomes = Object.keys(zip.files).filter(
        (n) => !zip.files[n].dir && /\.(xml|pdf)$/i.test(n)
      );
      for (const n of nomes) {
        const blob = await zip.files[n].async('blob');
        const interno = new File([blob], n.split('/').pop(), {
          type: n.toLowerCase().endsWith('.xml') ? 'application/xml' : 'application/pdf'
        });
        try {
          saida.push(...(await lerArquivo(interno)));
        } catch (e) {
          saida.push({ erro: true, arquivoNome: n, mensagem: e.message });
        }
      }
      if (!saida.length) throw new Error('O ZIP não tem XML nem PDF de nota.');
      return saida;
    }
    throw new Error('Formato não suportado. Envie XML, PDF ou ZIP.');
  }

  /**
   * @param {File|File[]|FileList} entrada
   * @returns {Promise<{notas: Object[], erros: {arquivo: string, mensagem: string}[]}>}
   */
  async function ler(entrada) {
    const arquivos = entrada instanceof File ? [entrada] : Array.from(entrada);
    const notas = [], erros = [];
    for (const f of arquivos) {
      try {
        const lidas = await lerArquivo(f);
        lidas.forEach((n) => {
          if (n.erro) erros.push({ arquivo: n.arquivoNome, mensagem: n.mensagem });
          else notas.push(n);
        });
      } catch (e) {
        erros.push({ arquivo: f.name, mensagem: e.message });
      }
    }
    // XML tem prioridade sobre PDF da mesma nota (mesma chave)
    const porChave = new Map();
    const finais = [];
    notas.forEach((n) => {
      if (!n.chave) return finais.push(n);
      const existente = porChave.get(n.chave);
      if (!existente) { porChave.set(n.chave, n); finais.push(n); }
      else if (existente.origem === 'pdf' && n.origem === 'xml') {
        finais[finais.indexOf(existente)] = n;
        porChave.set(n.chave, n);
      }
    });
    return { notas: finais, erros };
  }

  global.NotaImport = {
    ler,
    numeroBr,
    soDigitos,
    chaveValida,
    chavePlausivel,
    dadosDaChave,
    arred,
    calcularCusto,
    ratear
  };
})(window);

/* ---------------------------------------------------------------------
 * Formato devolvido em notas[i]:
 * {
 *   origem: 'xml' | 'pdf',
 *   arquivoNome, chave, numero, serie, emissao (yyyy-mm-dd),
 *   confianca: { cabecalho: 'alta'|'media', itens: 'alta'|'media'|'baixa' },
 *   fornecedor: { cnpj, nome, fantasia, ie },
 *   totais: { produtos, frete, seguro, desconto, outros, ipi, st, nota },
 *   itens: [{
 *     ordem, codigoFornecedor, ean, descricao, ncm, cfop, unidade,
 *     quantidade, valorUnitario, valorProdutos,
 *     frete, seguro, desconto, outros, ipi, st,
 *     custoUnitario, fatorConversao,
 *     unidadeTributavel?, fatorSugerido?
 *   }],
 *   avisos: string[],
 *   xmlTexto?: string
 * }
 * ------------------------------------------------------------------- */

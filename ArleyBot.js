import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage, delay, generateWAMessageFromContent, prepareWAMessageMedia, proto } from '@whiskeysockets/baileys';
import * as BaileysOptionalExports from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { writeFile, readFile, unlink, mkdir, readdir, rm, rename, stat } from 'fs/promises';
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, readlinkSync, realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import ytSearch from 'yt-search';
import readline from 'readline';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// O libsignal usado por algumas versões do Baileys escreve diretamente no
// console, ignorando o logger Pino. Filtramos apenas os diagnósticos conhecidos
// de sessão Signal e resumimos falhas de descriptografia, sem silenciar os logs do bot.
const consoleOriginalArley = Object.fromEntries(
    ['log', 'info', 'warn', 'error', 'debug'].map(metodo => [metodo, console[metodo].bind(console)])
);
let ultimoAvisoDescriptografiaSignal = 0;
const PADROES_LOG_SIGNAL_RUIDOSO = [
    /^Closing (?:stale open session|open session|session)\b/i,
    /^Decrypted message with closed session\.?$/i
];
const PADROES_ERRO_SIGNAL_DESCRIPTOGRAFIA = [
    /^Failed to decrypt message with any known session\b/i,
    /^Session error:\s*(?:Error:\s*)?Bad MAC\b/i,
    /^Session error:\s*MessageCounterError: Key used already or never filled\b/i,
    /^MessageCounterError: Key used already or never filled\b/i
];
for (const metodo of Object.keys(consoleOriginalArley)) {
    const original = consoleOriginalArley[metodo];
    console[metodo] = (...args) => {
        const primeiroArgumento = typeof args[0] === 'string'
            ? args[0].trim()
            : args[0] instanceof Error
                ? `${args[0].name}: ${args[0].message}`
                : '';

        // Estes logs contêm dumps extensos de chaves/sessões e não ajudam a diagnosticar o bot.
        if (PADROES_LOG_SIGNAL_RUIDOSO.some(regex => regex.test(primeiroArgumento))) return;

        // Erros de descriptografia podem ocorrer com mensagens duplicadas/fora de ordem.
        // Não escondemos totalmente o fato: emitimos somente um aviso resumido por minuto.
        if (PADROES_ERRO_SIGNAL_DESCRIPTOGRAFIA.some(regex => regex.test(primeiroArgumento))) {
            const agora = Date.now();
            if (agora - ultimoAvisoDescriptografiaSignal >= 60_000) {
                ultimoAvisoDescriptografiaSignal = agora;
                consoleOriginalArley.warn(
                    '[SIGNAL] O Baileys não conseguiu descriptografar uma mensagem recebida. ' +
                    'Isso não invalida automaticamente o login; detalhes repetidos foram omitidos.'
                );
            }
            return;
        }
        return original(...args);
    };
}

// O Signal antigo pode testar várias sessões inválidas em sequência. Cada tentativa
// faz criptografia síncrona antes do primeiro await; ceder ao event loop entre elas
// ajuda o keepalive do WhatsApp a continuar funcionando durante falhas de descriptografia.
// A alteração é guardada por compatibilidade: se a API interna mudar, o bot segue normal.
function aplicarMitigacaoEventLoopSignal() {
    try {
        const requireArleyBot = createRequire(import.meta.url);
        const libsignalArley = requireArleyBot('libsignal');
        const SessionCipherArley = libsignalArley?.SessionCipher
            || libsignalArley?.default?.SessionCipher
            || (typeof libsignalArley === 'function' ? libsignalArley : null);
        const prototipoCipherArley = SessionCipherArley?.prototype;
        const metodoOriginal = prototipoCipherArley?.doDecryptWhisperMessage;
        const marcadorPatch = Symbol.for('arleybot.signal.decryptYieldPatch.v1');

        if (!prototipoCipherArley || typeof metodoOriginal !== 'function' || prototipoCipherArley[marcadorPatch]) {
            return false;
        }

        Object.defineProperty(prototipoCipherArley, 'doDecryptWhisperMessage', {
            configurable: true,
            writable: true,
            value: async function (...args) {
                await new Promise(resolve => setImmediate(resolve));
                return metodoOriginal.apply(this, args);
            }
        });
        Object.defineProperty(prototipoCipherArley, marcadorPatch, { value: true });
        return true;
    } catch (_) {
        return false;
    }
}
const mitigacaoEventLoopSignalAtiva = aplicarMitigacaoEventLoopSignal();
if (mitigacaoEventLoopSignalAtiva) {
    consoleOriginalArley.log('[SIGNAL] Mitigação de bloqueio do event loop ativada.');
}

// Lista de comandos reais usada para sugerir correções de digitação, sem adivinhar comandos inexistentes.
const COMANDOS_SUGESTAO = new Set([
    'abrir',
    'aceitar',
    'aceiteduelo',
    'achatar',
    'achievements',
    'acmd',
    'add',
    'antiporno',
    'antispam',
    'apagar',
    'apostar',
    'ativarmsgale0',
    'ativarmsgale1',
    'ativarverquemmodificou0',
    'ativarverquemmodificou1',
    'ativatmsgale0',
    'aumentarcredito',
    'aumentarlimite',
    'aviso',
    'avisosoff',
    'avisoson',
    'ban',
    'bem-vindo',
    'bemvindo',
    'morrer',
    'morrer_nao',
    'morrer_sim',
    'banco',
    'bateriadogrupo',
    'beija',
    'beijar',
    'beijo',
    'bolsonarista',
    'brincadeiras0',
    'brincadeiras1',
    'buy',
    'buyxp',
    'cancelar',
    'cadastrarbanco',
    'cartao',
    'carteira',
    'cartãodecredito',
    'centraldono',
    'cheira',
    'cheirar',
    'cheirarcu',
    'comprar',
    'comprarxp',
    'conquistas',
    'credito',
    'd',
    'daily',
    'demote',
    'depositar',
    'deposito',
    'desativarcada',
    'desligar',
    'dgrp',
    'diario',
    'dono',
    'duelar',
    'duelo',
    'velha',
    'velhaaceitar',
    'velharecusar',
    'jogodavelha',
    'jogar',
    'adivinhar',
    'chute',
    'cobra',
    'quiz',
    'admgrupo',
    'icon',
    'emprestimo',
    'estourar',
    'extrato',
    'f',
    'fechar',
    'fixar',
    'fuder',
    'gemini',
    'genini',
    'gozarem',
    'gp',
    'gpdinheiro',
    'gpt',
    'grok',
    'historico',
    'kick',
    'ligar',
    'limite',
    'limiteemprestimo',
    'link',
    'loan',
    'log',
    'loja',
    'maisrico',
    'maisricos',
    'marcar-todos',
    'menu',
    'menuadmin',
    'menuowner',
    'missao',
    'missoes',
    'molestar',
    'mute',
    'nao',
    'ngrp',
    'openai',
    'pagarcartao',
    'pagarcredito',
    'pagaremprestimo',
    'pedirlimite',
    'perfil',
    'painelbot',
    'painelgrupo',
    'configgrupo',
    'configurargrupo',
    'prefixo',
    'reportarbug',
    'status',
    'petista',
    'pin',
    'ping',
    'pix',
    'promote',
    'promover',
    'quitaremprestimo',
    'rank',
    'rankgay',
    'ranking',
    'rankpau',
    'rankrico',
    'reaviso',
    'rebaixar',
    'recusar',
    'resetgp',
    'resetgpdinheiro',
    'restart',
    'rico',
    'roubar',
    's',
    'sacar',
    'saque',
    'season',
    'setlog',
    'settat',
    'setteste',
    'shop',
    'sim',
    'sobre',
    'sorteiar',
    'statusjogador',
    'tagall',
    'tapa',
    'temporada',
    'testar',
    'toaudio',
    'toimg',
    'totag',
    'tovideo',
    'trabalhar',
    'traca',
    'tracar',
    'transferir',
    'traça',
    'traçar',
    'unmute',
    'unmuteall',
    'ver',
    'verquemmodificou',
    'work',
    'xai',
    'xp',
    'youtube',
    'yt'
]);

function normalizarComandoSugestao(valor) {
    return String(valor || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
        .trim()
        .toLowerCase();
}

function distanciaEdicao(a, b) {
    const anterior = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const atual = [i];
        for (let j = 1; j <= b.length; j++) {
            atual[j] = Math.min(
                atual[j - 1] + 1,
                anterior[j] + 1,
                anterior[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
        for (let j = 0; j <= b.length; j++) anterior[j] = atual[j];
    }
    return anterior[b.length];
}

function sugerirComandoParecido(comando) {
    const alvo = normalizarComandoSugestao(comando);
    if (alvo.length < 3) return null;

    const candidatos = [...COMANDOS_SUGESTAO]
        .map(original => ({ original, normalizado: normalizarComandoSugestao(original) }))
        .filter(item => item.normalizado.length >= 3 && item.normalizado !== alvo);
    let melhor = null;
    for (const candidato of candidatos) {
        const tamanho = Math.max(alvo.length, candidato.normalizado.length);
        const distancia = distanciaEdicao(alvo, candidato.normalizado);
        const semelhanca = 1 - distancia / Math.max(1, tamanho);
        // Permite até dois erros em comandos curtos/médios, cobrindo casos como
        // .gemai -> .gemini, sem executar automaticamente o comando sugerido.
        const limite = Math.min(3, Math.max(1, Math.floor(tamanho * 0.34)));
        if (distancia > limite || semelhanca < 0.64) continue;
        if (!melhor || semelhanca > melhor.semelhanca ||
            (semelhanca === melhor.semelhanca && distancia < melhor.distancia)) {
            melhor = { comando: candidato.original, semelhanca, distancia };
        }
    }
    return melhor?.comando || null;
}

// Processos externos são rastreados para evitar yt-dlp/FFmpeg órfãos após restart.
const processosExternosAtivos = new Set();
// Impede que comandos simultâneos escolham a mesma animação antes de salvar o histórico.
const postsGifNsfwEmProcessamento = new Set();

function sinalizarProcessoExterno(processo, sinal = 'SIGKILL') {
    if (!processo) return;
    // No Android/Linux, cada tarefa fica em seu próprio grupo para podermos
    // finalizar também subprocessos do yt-dlp/FFmpeg. No Windows usamos kill normal.
    if (process.platform !== 'win32' && processo.pid) {
        try { process.kill(-processo.pid, sinal); return; } catch (_) {}
    }
    try { processo.kill(sinal); } catch (_) {}
}

function encerrarProcessosExternos(sinal = 'SIGKILL') {
    for (const processo of processosExternosAtivos) sinalizarProcessoExterno(processo, sinal);
}

// Execução de processos externos com timeout para impedir travamentos em FFmpeg/yt-dlp.
function executarProcesso(comando, argumentos = [], opcoes = {}) {
    const timeoutMs = Number(opcoes.timeoutMs) || 120000;
    const maxBuffer = Number(opcoes.maxBuffer) || 2 * 1024 * 1024;
    const controleDownload = opcoes.controleDownload || null;
    return new Promise((resolve, reject) => {
        if (controleDownload?.cancelado) {
            reject(new Error('DOWNLOAD_CANCELADO'));
            return;
        }

        let processo;
        try {
            processo = spawn(comando, argumentos, {
                cwd: opcoes.cwd || __dirname,
                windowsHide: true,
                detached: process.platform !== 'win32',
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (erroSpawn) {
            reject(erroSpawn);
            return;
        }

        processosExternosAtivos.add(processo);
        if (controleDownload) controleDownload.processo = processo;
        let stdout = '';
        let stderr = '';
        let finalizado = false;

        const limpar = () => {
            processosExternosAtivos.delete(processo);
            if (controleDownload?.processo === processo) controleDownload.processo = null;
            clearTimeout(timer);
        };
        const timer = setTimeout(() => {
            sinalizarProcessoExterno(processo, 'SIGKILL');
            if (!finalizado) {
                finalizado = true;
                limpar();
                reject(new Error(`${comando} excedeu o tempo limite de ${Math.round(timeoutMs / 1000)}s.`));
            }
        }, timeoutMs);

        processo.stdout.on('data', chunk => {
            const texto = chunk.toString();
            stdout += texto;
            if (stdout.length > maxBuffer) stdout = stdout.slice(-maxBuffer);
            if (typeof opcoes.onStdout === 'function') {
                try { opcoes.onStdout(texto); } catch (erroCallback) {
                    console.warn(`⚠️ Callback de stdout falhou em ${comando}:`, erroCallback?.message || erroCallback);
                }
            }
        });
        processo.stderr.on('data', chunk => {
            const texto = chunk.toString();
            stderr += texto;
            if (stderr.length > maxBuffer) stderr = stderr.slice(-maxBuffer);
            if (typeof opcoes.onStderr === 'function') {
                try { opcoes.onStderr(texto); } catch (erroCallback) {
                    console.warn(`⚠️ Callback de stderr falhou em ${comando}:`, erroCallback?.message || erroCallback);
                }
            }
        });
        processo.on('error', erro => {
            if (finalizado) return;
            finalizado = true;
            limpar();
            reject(controleDownload?.cancelado ? new Error('DOWNLOAD_CANCELADO') : erro);
        });
        processo.on('close', (codigo, sinal) => {
            if (finalizado) return;
            finalizado = true;
            limpar();
            if (controleDownload?.cancelado) {
                reject(new Error('DOWNLOAD_CANCELADO'));
                return;
            }
            if (codigo === 0) return resolve({ stdout, stderr });
            const detalhe = (stderr || stdout || `código ${codigo ?? 'desconhecido'}${sinal ? ` (${sinal})` : ''}`).trim().slice(-3000);
            reject(new Error(`${comando} falhou: ${detalhe}`));
        });
    });
}
async function executarImageMagick(argumentos = [], opcoes = {}) {
    try {
        return await executarProcesso('magick', argumentos, opcoes);
    } catch (erroMagick) {
        const mensagem = String(erroMagick?.message || erroMagick || '');
        // Algumas versões/pacotes do ImageMagick no Android expõem apenas `convert`.
        if (!/ENOENT|spawn magick|magick.*not found|no such file or directory/i.test(mensagem)) throw erroMagick;
        try {
            return await executarProcesso('convert', argumentos, opcoes);
        } catch (erroConvert) {
            throw new Error(`ImageMagick não está disponível como magick nem convert. Instale com: pkg install imagemagick -y. Detalhe: ${erroConvert?.message || erroMagick?.message || 'comando ausente'}`);
        }
    }
}

async function executarComTentativas(fn, tentativas = 2, esperaMs = 700) {
    let ultimoErro;
    for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
        try {
            return await fn(tentativa);
        } catch (erro) {
            ultimoErro = erro;
            if (tentativa < tentativas) await new Promise(resolve => setTimeout(resolve, esperaMs * tentativa));
        }
    }
    throw ultimoErro || new Error('Operação falhou.');
}

// Compatibilidade entre versões do Baileys: o readyState pode ficar em
// propriedades internas diferentes. Não depender apenas de sock.ws.readyState.
function obterReadyStateWebSocket(socket) {
    const valores = [
        socket?.ws?.readyState,
        socket?.ws?.socket?.readyState,
        socket?.ws?.ws?.readyState,
        socket?.ws?._socket?.readyState,
        socket?.websocket?.readyState,
        socket?.socket?.readyState,
        socket?.ws?.isOpen === true ? 1 : socket?.ws?.isOpen === false ? 3 : undefined,
        socket?.ws?.socket?.isOpen === true ? 1 : socket?.ws?.socket?.isOpen === false ? 3 : undefined
    ];
    return valores.find(valor => typeof valor === 'number' && Number.isFinite(valor));
}

const NOME_PACK_FIGURINHA = 'ArleyBot';
const AUTOR_PACK_FIGURINHA = '4.3.7';
const LIMITE_FIGURINHA_VIDEO_SEGUNDOS = 10;
const LIMITE_DURACAO_LINK_SEGUNDOS = 340;

// Parâmetros compartilhados para redes móveis instáveis (TikTok/Instagram/etc.).
const ARGUMENTOS_YTDLP_REDE = [
    '--socket-timeout', '25',
    '--retries', '5',
    '--fragment-retries', '5',
    '--extractor-retries', '5',
    '--retry-sleep', 'http:exp=1:8',
    '--retry-sleep', 'extractor:exp=1:8'
];
// A pré-consulta de duração é curta; se o site não responder, o download
// principal ainda faz tentativas mais completas e a duração é validada depois.
const ARGUMENTOS_YTDLP_METADADOS = [
    '--socket-timeout', '12',
    '--retries', '1',
    '--extractor-retries', '1'
];


// Usa a instalação mais nova do yt-dlp disponível: no Termux, o executável
// `yt-dlp` do PATH pode ser antigo mesmo quando o pacote do Python já foi atualizado.
let comandoYtDlpSelecionado = null;
let promessaResolucaoYtDlp = null;
let argumentosRuntimeYtDlpCache = null;
let promessaRuntimeYtDlp = null;

function analisarVersaoYtDlp(saida) {
    const texto = String(saida || '');
    const m = texto.match(/(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d+))?/);
    if (!m) return { versao: texto.trim().split(/\r?\n/)[0] || 'desconhecida', ordem: 0 };
    return {
        versao: m[0],
        ordem: Number(m[1]) * 1_000_000_000 + Number(m[2]) * 10_000_000 + Number(m[3]) * 100_000 + Number(m[4] || 0)
    };
}

async function resolverComandoYtDlp() {
    if (comandoYtDlpSelecionado) return comandoYtDlpSelecionado;
    if (promessaResolucaoYtDlp) return promessaResolucaoYtDlp;

    promessaResolucaoYtDlp = (async () => {
        const candidatos = [
            { comando: 'yt-dlp', prefixo: [], prioridade: 0 },
            { comando: 'python3', prefixo: ['-m', 'yt_dlp'], prioridade: 1 },
            { comando: 'python', prefixo: ['-m', 'yt_dlp'], prioridade: 2 }
        ];
        const disponiveis = (await Promise.all(candidatos.map(async candidato => {
            try {
                const resultado = await executarProcesso(
                    candidato.comando,
                    [...candidato.prefixo, '--version'],
                    { timeoutMs: 10000, maxBuffer: 64 * 1024 }
                );
                const versao = analisarVersaoYtDlp(`${resultado.stdout || ''}\n${resultado.stderr || ''}`);
                return { ...candidato, ...versao };
            } catch (erro) {
                return null;
            }
        }))).filter(Boolean);

        if (!disponiveis.length) {
            throw new Error('Não encontrei uma instalação executável do yt-dlp. No Termux, instale com: pkg install python ffmpeg nodejs-lts && python3 -m pip install -U "yt-dlp[default]"');
        }

        // A versão mais recente vence; em caso de empate, preferimos o executável do PATH.
        disponiveis.sort((a, b) => b.ordem - a.ordem || a.prioridade - b.prioridade);
        comandoYtDlpSelecionado = disponiveis[0];
        // A escolha do executável é silenciosa; erros de download continuam sendo tratados.
        const dataVersao = String(comandoYtDlpSelecionado.versao).match(/^(\d{4})\.(\d{2})\.(\d{2})/);
        if (dataVersao) {
            const dataRelease = new Date(Date.UTC(Number(dataVersao[1]), Number(dataVersao[2]) - 1, Number(dataVersao[3])));
            const idadeDias = Math.floor((Date.now() - dataRelease.getTime()) / 86400000);
            if (Number.isFinite(idadeDias) && idadeDias > 90) {
                console.warn(`[yt-dlp] ⚠️ A versão selecionada tem ${idadeDias} dias. No Termux, atualize o módulo Python com: python3 -m pip install -U \"yt-dlp[default]\" e reinicie o bot. Versão selecionada: ${comandoYtDlpSelecionado.versao}.`);
            }
        }
        return comandoYtDlpSelecionado;
    })();

    try {
        return await promessaResolucaoYtDlp;
    } finally {
        promessaResolucaoYtDlp = null;
    }
}

async function obterArgumentosRuntimeYtDlp() {
    if (argumentosRuntimeYtDlpCache) return argumentosRuntimeYtDlpCache;
    if (promessaRuntimeYtDlp) return promessaRuntimeYtDlp;

    promessaRuntimeYtDlp = (async () => {
        // Versões recentes do yt-dlp dependem de um runtime JS para alguns desafios do YouTube.
        for (const runtime of ['deno', 'node']) {
            try {
                const teste = await executarProcesso(runtime, ['--version'], { timeoutMs: 5000, maxBuffer: 32 * 1024 });
                const versaoTexto = String(teste.stdout || teste.stderr || '').trim();
                const m = versaoTexto.match(/(?:v|deno\s+)?(\d+)\.(\d+)\.(\d+)/i);
                if (runtime === 'deno' && m && (Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) < 3))) continue;
                if (runtime === 'node' && m && Number(m[1]) < 20) continue;
                return ['--js-runtimes', runtime];
            } catch (_) {}
        }
        return [];
    })();

    try {
        argumentosRuntimeYtDlpCache = await promessaRuntimeYtDlp;
        return argumentosRuntimeYtDlpCache;
    } finally {
        promessaRuntimeYtDlp = null;
    }
}

async function executarYtDlp(argumentos = [], opcoes = {}) {
    const configuracao = await resolverComandoYtDlp();
    const runtimeArgs = await obterArgumentosRuntimeYtDlp();
    try {
        return await executarProcesso(
            configuracao.comando,
            [...configuracao.prefixo, ...runtimeArgs, ...argumentos],
            opcoes
        );
    } catch (erro) {
        if (/ENOENT|spawn .*not found/i.test(String(erro?.message || ''))) {
            comandoYtDlpSelecionado = null;
        }
        throw erro;
    }
}

function argumentosForcarIPv4SeYouTube(url) {
    try {
        const host = new URL(String(url)).hostname.toLowerCase();
        if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
            return ['--force-ipv4'];
        }
    } catch (_) {}
    return [];
}


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARLEYBOT_VERSION = '4.3.7';
const ARLEYBOT_BUILD_ID = 'V48-LID-GROUP-AUTH-20261019-04';
// Informações de build ficam disponíveis no comando de diagnóstico; não poluir o Termux.

const PASTA_MIDIA = path.join(__dirname, 'midia');
// GIFs usados em brincadeiras ficam numa pasta própria ao lado de index.js.
const PASTA_GIF = path.join(__dirname, 'gif');
const PASTA_TEMP = path.join(__dirname, 'temp');
const IDADE_MAX_TEMPORARIOS_MS = 24 * 60 * 60 * 1000;

// Seleciona um GIF da brincadeira correta e converte para vídeo animado compatível com WhatsApp.
// Exemplos aceitos: tracar.gif, traçar_1.gif, beijar.gif, beijo-02.mp4.
async function criarVideoGifBrincadeira(tipo) {
    const aliases = tipo === 'tracar' ? ['tracar', 'traca'] : ['beijar', 'beija', 'beijo'];
    const normalizarNomeGif = valor => String(valor || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    let arquivoEntrada = null;
    let arquivoSaida = null;
    try {
        await mkdir(PASTA_GIF, { recursive: true });
        await mkdir(PASTA_TEMP, { recursive: true });
        const itens = await readdir(PASTA_GIF, { withFileTypes: true });
        const candidatos = [];
        for (const item of itens) {
            if (!item.isFile() || !/\.(?:gif|mp4|webm|mov)$/i.test(item.name)) continue;
            const base = normalizarNomeGif(item.name.replace(/\.[^.]+$/, ''));
            // Nunca reutiliza arquivos da brincadeira de tapa nos comandos de beijo.
            if (tipo === 'beijar' && /^tapa(?:$|[_ -]|\d)/.test(base)) continue;
            const corresponde = aliases.some(alias => base === alias || new RegExp(`^${alias}(?:$|[_ -]|\\d)`).test(base));
            if (!corresponde) continue;
            const caminho = path.join(PASTA_GIF, item.name);
            try {
                const stat = await (await import('fs/promises')).stat(caminho);
                if (stat.isFile() && stat.size > 0 && stat.size <= 25 * 1024 * 1024) candidatos.push(caminho);
            } catch (_) {}
        }
        if (!candidatos.length) {
            const exemplo = tipo === 'tracar' ? 'traçar.gif ou traçar_1.gif' : 'beijar.gif ou beijar_1.gif';
            throw new Error(`NO_BRINCADEIRA_GIF: Nenhum arquivo para ${tipo}. Coloque na pasta gif/ um arquivo como ${exemplo} (GIF, MP4, WEBM ou MOV, até 25 MB).`);
        }

        arquivoEntrada = candidatos[Math.floor(Math.random() * candidatos.length)];
        arquivoSaida = path.join(PASTA_TEMP, `${tipo}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}.mp4`);

        const converter = async (reduzido = false) => {
            const largura = reduzido ? '320' : '360';
            const fps = reduzido ? '10' : '12';
            const crf = reduzido ? '34' : '31';
            await executarProcesso('ffmpeg', [
                '-hide_banner', '-loglevel', 'error', '-y',
                '-i', arquivoEntrada,
                '-t', '8',
                '-vf', `fps=${fps},scale=${largura}:-2:flags=lanczos`,
                '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
                '-crf', crf, '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart', '-f', 'mp4', arquivoSaida
            ], { timeoutMs: 45000, maxBuffer: 256 * 1024 });
        };

        await converter(false);
        let statSaida = await (await import('fs/promises')).stat(arquivoSaida);
        if (!statSaida.isFile() || statSaida.size <= 0) throw new Error('O FFmpeg não gerou um vídeo válido.');
        if (statSaida.size > 8 * 1024 * 1024) {
            await converter(true);
            statSaida = await (await import('fs/promises')).stat(arquivoSaida);
        }
        if (statSaida.size > 8 * 1024 * 1024) throw new Error('A animação convertida ficou maior que 8 MB. Use um GIF menor.');
        return await readFile(arquivoSaida);
    } finally {
        if (arquivoSaida) await unlink(arquivoSaida).catch(() => {});
    }
}

// Envia a animação com as menções dentro da PRÓPRIA legenda da mídia.
// Em grupos grandes, divide as menções em legendas de novas cópias do GIF para
// evitar exceder o limite de legenda do WhatsApp; nunca manda a lista em texto separado.
async function enviarGifComTodosNaLegenda({ sock, remoteJid, buffer, legendaBase, autorJid, participantesJid, quoted }) {
    const autor = String(autorJid || '');
    const autorNormalizado = normalizarJid(autor);
    const unicos = [];
    const vistos = new Set();
    for (const jid of participantesJid || []) {
        if (!jid) continue;
        const chave = normalizarJid(jid);
        if (!chave || vistos.has(chave)) continue;
        vistos.add(chave);
        unicos.push(jid);
    }

    // O autor já está citado no texto introdutório; evita repetir sua marcação.
    const demais = unicos.filter(jid => normalizarJid(jid) !== autorNormalizado);
    const LIMITE_LEGENDA = 900; // margem abaixo do limite habitual de legenda de mídia.
    const partes = [];
    let atual = [];
    let tamanhoAtual = String(legendaBase || '').length + 2;
    for (const jid of demais) {
        const token = `@${normalizarJid(jid)}`;
        const acrescimo = token.length + (atual.length ? 1 : 0);
        if (atual.length && tamanhoAtual + acrescimo > LIMITE_LEGENDA) {
            partes.push(atual);
            atual = [];
            tamanhoAtual = String(legendaBase || '').length + 2;
        }
        atual.push(jid);
        tamanhoAtual += token.length + (atual.length > 1 ? 1 : 0);
    }
    if (atual.length || !partes.length) partes.push(atual);

    let ultimaMensagem;
    for (let i = 0; i < partes.length; i++) {
        const tokens = partes[i].map(jid => `@${normalizarJid(jid)}`).join(' ');
        const rotuloParte = partes.length > 1 ? `\n\n📣 Marcações ${i + 1}/${partes.length}` : '';
        const legenda = `${String(legendaBase || '').trim()}${rotuloParte}${tokens ? `\n\n${tokens}` : ''}`;
        const mentions = [...new Map([autor, ...partes[i]].filter(Boolean).map(jid => [normalizarJid(jid), jid])).values()];
        ultimaMensagem = await sock.sendMessage(remoteJid, {
            video: buffer,
            mimetype: 'video/mp4',
            gifPlayback: true,
            caption: legenda,
            mentions
        }, { quoted });
    }
    return ultimaMensagem;
}
let limpezaTemporariosEmAndamento = false;

// Limpeza conservadora: só remove arquivos/pastas dentro de ./temp com mais de 24h.
// Nunca toca em sessao_bot, dados.json, arquivos do projeto ou mídias recentes.
async function limparArquivosTemporariosAntigos() {
    if (limpezaTemporariosEmAndamento) return { removidos: 0, falhas: 0 };
    limpezaTemporariosEmAndamento = true;
    let removidos = 0;
    let falhas = 0;
    try {
        const raizTemp = path.resolve(PASTA_TEMP);
        const itens = await readdir(raizTemp, { withFileTypes: true }).catch(erro => {
            if (erro?.code === 'ENOENT') return [];
            throw erro;
        });
        const fsPromises = await import('fs/promises');
        const candidatos = [];
        for (const item of itens) {
            if (!item || item.name === '.' || item.name === '..') continue;
            const caminho = path.resolve(raizTemp, item.name);
            if (!caminho.startsWith(`${raizTemp}${path.sep}`)) continue;
            try {
                const stat = await fsPromises.stat(caminho);
                if (!stat.isDirectory() && !stat.isFile()) continue;
                if (Date.now() - stat.mtimeMs >= IDADE_MAX_TEMPORARIOS_MS) {
                    candidatos.push({ caminho, mtimeMs: stat.mtimeMs });
                }
            } catch (erroStat) {
                if (erroStat?.code !== 'ENOENT') falhas++;
            }
        }
        candidatos.sort((a, b) => a.mtimeMs - b.mtimeMs);
        // Cota por rodada: evita uma limpeza grande bloquear o celular por muito tempo.
        for (const item of candidatos.slice(0, 50)) {
            try {
                await rm(item.caminho, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
                removidos++;
            } catch (_) { falhas++; }
        }
    } catch (erro) {
        if (erro?.code !== 'ENOENT') console.warn('[TEMP] Limpeza automática adiada:', erro?.message || erro);
        falhas++;
    } finally {
        limpezaTemporariosEmAndamento = false;
    }
    return { removidos, falhas };
}
const timerLimpezaArquivosTemporarios = setInterval(() => {
    void limparArquivosTemporariosAntigos();
}, 6 * 60 * 60 * 1000);
timerLimpezaArquivosTemporarios.unref?.();

// Sempre use a sessão localizada junto ao index.js. Caminhos relativos ao
// diretório atual podem carregar/criar outra sessão quando o Termux inicia
// o projeto a partir de uma pasta diferente.
const PASTA_SESSAO = path.join(__dirname, 'sessao_bot');
const ARQUIVO_DADOS = path.join(__dirname, 'dados.json');
const ARQUIVO_AVISO_RESTART = path.join(__dirname, 'restart_notice.json');
const ARQUIVO_CONFIG_CONEXAO = path.join(__dirname, 'conexao_bot.json');

async function lerConfigConexaoSalva() {
    try {
        const config = JSON.parse(await readFile(ARQUIVO_CONFIG_CONEXAO, 'utf8'));
        if (config?.modo === 'qr') return { modo: 'qr', numero: '' };
        if (config?.modo === 'codigo' && /^\d{10,15}$/.test(String(config.numero || ''))) {
            return { modo: 'codigo', numero: String(config.numero) };
        }
    } catch (_) {
        // Primeira execução ou arquivo ainda inexistente: perguntar uma única vez.
    }
    return null;
}

async function salvarConfigConexaoSalva(modo, numero = '') {
    if (!['qr', 'codigo'].includes(modo)) return false;
    const config = { modo, numero: modo === 'codigo' ? String(numero || '').replace(/\D/g, '') : '', atualizadoEm: new Date().toISOString() };
    try {
        await writeFile(ARQUIVO_CONFIG_CONEXAO, JSON.stringify(config, null, 2), 'utf8');
        return true;
    } catch (erro) {
        console.warn('[CONEXÃO] Não consegui salvar o método preferido; o bot ainda pode funcionar:', erro?.message || erro);
        return false;
    }
}

// Opcional: cookies Netscape exportados da sua própria sessão autenticada.
// Guarde o arquivo fora da pasta pública do projeto e configure YTDLP_COOKIES_FILE.
function argumentosCookiesYtDlp() {
    const configurado = String(process.env.YTDLP_COOKIES_FILE || '').trim();
    if (!configurado) return [];
    const caminho = path.isAbsolute(configurado) ? configurado : path.resolve(__dirname, configurado);
    if (!existsSync(caminho)) {
        throw new Error(`O arquivo indicado em YTDLP_COOKIES_FILE não existe: ${caminho}`);
    }
    return ['--cookies', caminho];
}

// Carrega chaves sem instalar dotenv. Preferência: arquivo privado no HOME do Termux.
// Ordem: ARLEYBOT_ENV_FILE, ~/.arleybot.env e, por compatibilidade, .env ao lado do index.js.
// Variáveis já exportadas no Termux sempre têm prioridade. Não coloque chaves em grupos/chats.
function carregarEnvLocal() {
    const home = process.env.HOME || process.env.USERPROFILE || __dirname;
    const configurado = String(process.env.ARLEYBOT_ENV_FILE || '').trim();
    const caminhoConfigurado = configurado
        ? (path.isAbsolute(configurado) ? configurado : path.resolve(home, configurado))
        : '';
    const arquivosEnv = [...new Set([
        caminhoConfigurado,
        path.join(home, '.arleybot.env'),
        path.join(__dirname, '.env')
    ].filter(Boolean))];
    for (const arquivoEnv of arquivosEnv) {
        if (!existsSync(arquivoEnv)) continue;
        try {
            const conteudo = readFileSync(arquivoEnv, 'utf8');
            for (const linhaOriginal of conteudo.split(/\r?\n/)) {
                const linha = linhaOriginal.trim();
                if (!linha || linha.startsWith('#')) continue;
                const correspondencia = linha.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
                if (!correspondencia) continue;
                const nome = correspondencia[1];
                let valor = correspondencia[2].trim();
                if ((valor.startsWith('\"') && valor.endsWith('\"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
                    valor = valor.slice(1, -1);
                } else {
                    valor = valor.replace(/\s+#.*$/, '').trim();
                }
                if (!String(process.env[nome] || '').trim()) process.env[nome] = valor;
            }
        } catch (erroEnv) {
            console.warn(`[IA] Não consegui ler ${path.basename(arquivoEnv)}:`, erroEnv?.message || erroEnv);
        }
    }
    // A configuração é carregada silenciosamente para manter o terminal limpo.
}
carregarEnvLocal();

// Aceita nomes alternativos comuns para evitar falso aviso de chave ausente.
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY || '').trim();
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.GPT_API_KEY || '').trim();
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.1';
const XAI_API_KEY = String(process.env.XAI_API_KEY || process.env.GROK_API_KEY || process.env.XAI_KEY || '').trim();
const XAI_MODEL = process.env.XAI_MODEL || 'grok-4.6';

const INSTRUCOES_IA_NATURAL = [
    'Converse em português brasileiro com naturalidade, como numa conversa real por mensagem.',
    'Responda diretamente ao que a pessoa disse, com tom amigável e simples, sem formalidade desnecessária.',
    'Não comece com frases prontas como “Claro, aqui está”, “Com certeza” ou “Como uma IA”.',
    'Não fale sobre ser IA espontaneamente; se perguntarem diretamente, responda com honestidade, sem fingir ser humano.',
    'Não repita a pergunta antes de responder.',
    'Use gírias apenas quando combinarem com o tom da pessoa; não force intimidade nem exagero.',
    'Prefira respostas curtas em conversas casuais e detalhe mais quando a pessoa pedir explicação.',
    'Não invente fatos: quando não souber ou houver dúvida, diga isso com clareza.',
    'Evite títulos, listas e emojis em excesso; use-os somente quando ajudarem a conversa.'
].join(' ');

// Impede que chamadas da IA fiquem presas por tempo indeterminado e atrasem o bot.
async function fetchIAComTimeout(url, opcoes = {}, timeoutMs = 25000) {
    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort(), timeoutMs);
    try {
        return await fetch(url, { ...opcoes, signal: controlador.signal });
    } finally {
        clearTimeout(temporizador);
    }
}

// Não listar configuração de provedores no terminal a cada inicialização.

// Caches limitados: evitam crescimento contínuo de RAM em grupos movimentados.
const cacheMensagens = new Map(); // id -> { mensagem, expiraEm }
const cacheBuffersVisu = new Map(); // id -> { buffer, type, caption, mimetype, expiraEm }
const TTL_CACHE_MENSAGENS_MS = 2 * 60 * 60 * 1000;
const MAX_CACHE_MENSAGENS = 1500;
const MAX_CACHE_VISU_ITENS = 8;
const MAX_CACHE_VISU_ITEM_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_VISU_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_MENSAGENS_PROCESSADAS = 5000;
const MAX_MENSAGENS_IGNORAR = 1000;

// Evita farm de XP por flood (armazena o último que enviou mensagem no grupo)
const ultimoRemetenteGrupo = new Map();

const pendentesYouTube = {};
const downloadsAtivos = new Set();
// Cada controle aponta apenas para o processo em execução; não guarda buffers de mídia.
const controlesDownloadsAtivos = new Map();
function chaveDonoControleDownload(remoteJid, sender) {
    return `${remoteJid}:${normalizarJid(sender) || String(sender || '')}`;
}
function registrarControleDownload(chaveDono, controle) {
    if (!chaveDono || !controle) return;
    let controles = controlesDownloadsAtivos.get(chaveDono);
    if (!controles) { controles = new Set(); controlesDownloadsAtivos.set(chaveDono, controles); }
    controles.add(controle);
}
function retirarControleDownload(chaveDono, controle) {
    const controles = controlesDownloadsAtivos.get(chaveDono);
    if (!controles) return;
    controles.delete(controle);
    if (controles.size === 0) controlesDownloadsAtivos.delete(chaveDono);
}
function cancelarControlesDownloads(chaveDono) {
    const controles = controlesDownloadsAtivos.get(chaveDono);
    if (!controles?.size) return 0;
    let cancelados = 0;
    for (const controle of controles) {
        if (!controle.cancelado) {
            controle.cancelado = true;
            cancelados++;
        }
        if (controle.processo) {
            const processoAlvo = controle.processo;
            sinalizarProcessoExterno(processoAlvo, 'SIGTERM');
            const timerForca = setTimeout(() => {
                if (controle.processo === processoAlvo) sinalizarProcessoExterno(processoAlvo, 'SIGKILL');
            }, 1500);
            timerForca.unref?.();
        }
    }
    return cancelados;
}
function verificarDownloadNaoCancelado(controle) {
    if (controle?.cancelado) throw new Error('DOWNLOAD_CANCELADO');
}
const MAX_PENDENTES_YOUTUBE = 100;
const TTL_PENDENTE_YOUTUBE_MS = 15 * 60 * 1000;

// 🔒 CONTEXTO DOS FLUXOS INTERATIVOS
// Cada confirmação/etapa pertence ao chat onde o comando foi iniciado.
function chaveEstadoChat(sender, remoteJid) {
    return `${remoteJid}::${sender}`;
}

const aguardandoAcaoLog = {};
const temporizadoresLog = {};

const aguardandoAcaoTestar = {};
const temporizadoresTestar = {};

const aguardandoAcaoAviso = {};
const temporizadoresAviso = {};

// Fluxos exclusivos do dono para administrar os dados dos grupos
const aguardandoGPDinheiro = {};
const temporizadoresGPDinheiro = {};
const aguardandoResetGP = {};
const temporizadoresResetGP = {};

// Novos sistemas da economia/jogador
const duelosPendentes = {};
const temporizadoresDuelos = {}; // chave do duelo -> timeout de 60s

// Minigames voláteis: não são gravados em dados.json e expiram sozinhos ao serem acessados.
const jogosDaVelha = new Map();
const desafiosVelhaPendentes = new Map(); // remoteJid -> convite aguardando o jogador desafiante aceitar
const jogosAdivinhar = new Map();
const jogosCobrinha = new Map();
const jogosQuiz = new Map();
const TTL_JOGO_VELHA_MS = 10 * 60 * 1000;
const TTL_DESAFIO_VELHA_MS = 60 * 1000;
const TTL_ADIVINHAR_MS = 5 * 60 * 1000;
const TTL_COBRINHA_MS = 10 * 60 * 1000;
const TTL_QUIZ_MS = 3 * 60 * 1000;
const MAX_MINIGAMES_POR_GRUPOS = 500;
const TAMANHO_TABULEIRO_COBRINHA = 6;

function sortearFrutaCobrinha(cobra) {
    const livres = [];
    for (let y = 0; y < TAMANHO_TABULEIRO_COBRINHA; y++) {
        for (let x = 0; x < TAMANHO_TABULEIRO_COBRINHA; x++) {
            if (!cobra.some(p => p.x === x && p.y === y)) livres.push({ x, y });
        }
    }
    if (!livres.length) return null;
    return livres[Math.floor(Math.random() * livres.length)];
}

function renderizarTabuleiroCobrinha(jogo) {
    const linhas = [];
    for (let y = 0; y < TAMANHO_TABULEIRO_COBRINHA; y++) {
        const celulas = [];
        for (let x = 0; x < TAMANHO_TABULEIRO_COBRINHA; x++) {
            const corpoIndex = jogo.cobra.findIndex(p => p.x === x && p.y === y);
            if (corpoIndex === 0) celulas.push('🐍');
            else if (corpoIndex > 0) celulas.push('🟩');
            else if (jogo.fruta && jogo.fruta.x === x && jogo.fruta.y === y) celulas.push('🍎');
            else celulas.push('▫️');
        }
        linhas.push(celulas.join(''));
    }
    return linhas.join('\n');
}

function normalizarRespostaQuiz(valor) {
    return String(valor || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const BANCO_QUIZ_ARLEY = [
    { pergunta: 'Qual planeta é conhecido como Planeta Vermelho?', respostas: ['marte'] },
    { pergunta: 'Quantos lados tem um hexágono?', respostas: ['6', 'seis'] },
    { pergunta: 'Qual é o maior oceano da Terra?', respostas: ['pacifico', 'oceano pacifico'] },
    { pergunta: 'Qual é o resultado de 9 × 7?', respostas: ['63', 'sessenta e tres'] },
    { pergunta: 'Em qual país fica a Torre Eiffel?', respostas: ['franca', 'na franca'] },
    { pergunta: 'Qual é o satélite natural da Terra?', respostas: ['lua', 'a lua'] },
    { pergunta: 'Quantos minutos há em uma hora?', respostas: ['60', 'sessenta'] },
    { pergunta: 'Qual animal é conhecido como rei da selva?', respostas: ['leao', 'o leao'] },
    { pergunta: 'Qual é a capital do Brasil?', respostas: ['brasilia'] },
    { pergunta: 'Qual gás as plantas absorvem principalmente na fotossíntese?', respostas: ['dioxido de carbono', 'co2', 'gas carbonico'] },
    { pergunta: 'Quantas cores tem o arco-íris tradicionalmente?', respostas: ['7', 'sete'] },
    { pergunta: 'Qual é o primeiro mês do ano?', respostas: ['janeiro'] },
    { pergunta: 'Qual instrumento mede a temperatura?', respostas: ['termometro'] },
    { pergunta: 'Qual é o maior mamífero do mundo?', respostas: ['baleia azul', 'a baleia azul'] },
    { pergunta: 'Quanto é 100 dividido por 4?', respostas: ['25', 'vinte e cinco'] },
    { pergunta: 'Qual é o idioma oficial mais falado no Brasil?', respostas: ['portugues', 'português'] },
    { pergunta: 'Quantos dias tem uma semana?', respostas: ['7', 'sete'] },
    { pergunta: 'Qual é o metal precioso cujo símbolo químico é Au?', respostas: ['ouro'] },
    { pergunta: 'Qual parte da planta geralmente absorve água do solo?', respostas: ['raiz', 'raizes', 'raízes'] },
    { pergunta: 'Qual estrela fica no centro do nosso sistema solar?', respostas: ['sol', 'o sol'] }
];
function renderizarTabuleiroVelha(tabuleiro) {
    const casas = tabuleiro.map((marca, i) => marca === 'X' ? '❌' : marca === 'O' ? '⭕' : `${i + 1}️⃣`);
    return `${casas[0]} │ ${casas[1]} │ ${casas[2]}\n──┼───┼──\n${casas[3]} │ ${casas[4]} │ ${casas[5]}\n──┼───┼──\n${casas[6]} │ ${casas[7]} │ ${casas[8]}`;
}
function encontrarVencedorVelha(tabuleiro) {
    const linhas = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    for (const [a,b,c] of linhas) if (tabuleiro[a] && tabuleiro[a] === tabuleiro[b] && tabuleiro[a] === tabuleiro[c]) return tabuleiro[a];
    return tabuleiro.every(Boolean) ? 'EMPATE' : null;
}
function escolherJogadaBotVelha(tabuleiro) {
    const linhas = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    const procurar = marca => {
        for (const linha of linhas) {
            const ocupadas = linha.filter(i => tabuleiro[i] === marca).length;
            const livres = linha.filter(i => !tabuleiro[i]);
            if (ocupadas === 2 && livres.length === 1) return livres[0];
        }
        return -1;
    };
    let jogada = procurar('O');
    if (jogada < 0) jogada = procurar('X');
    if (jogada < 0 && !tabuleiro[4]) jogada = 4;
    if (jogada < 0) {
        const cantosLivres = [0,2,6,8].filter(i => !tabuleiro[i]);
        if (cantosLivres.length) jogada = cantosLivres[Math.floor(Math.random() * cantosLivres.length)];
    }
    if (jogada < 0) {
        const livres = tabuleiro.map((v,i) => v ? -1 : i).filter(i => i >= 0);
        if (livres.length) jogada = livres[Math.floor(Math.random() * livres.length)];
    }
    return jogada;
}
function podarMinigamesExpirados(agora = Date.now()) {
    for (const [jid, desafio] of desafiosVelhaPendentes) {
        if (!desafio || agora >= desafio.expiraEm) desafiosVelhaPendentes.delete(jid);
    }
    while (desafiosVelhaPendentes.size > MAX_MINIGAMES_POR_GRUPOS) {
        desafiosVelhaPendentes.delete(desafiosVelhaPendentes.keys().next().value);
    }
    for (const [jid, jogo] of jogosDaVelha) if (!jogo || agora - (jogo.ultimaAtividade || jogo.criadoEm) > TTL_JOGO_VELHA_MS) jogosDaVelha.delete(jid);
    for (const [jid, jogo] of jogosAdivinhar) if (!jogo || agora - jogo.criadoEm > TTL_ADIVINHAR_MS) jogosAdivinhar.delete(jid);
    for (const [jid, jogo] of jogosCobrinha) if (!jogo || agora - (jogo.ultimoMovimento || jogo.criadoEm) > TTL_COBRINHA_MS) jogosCobrinha.delete(jid);
    for (const [jid, jogo] of jogosQuiz) if (!jogo || agora - jogo.criadoEm > TTL_QUIZ_MS) jogosQuiz.delete(jid);
    for (const mapa of [jogosDaVelha, jogosAdivinhar, jogosCobrinha, jogosQuiz]) {
        while (mapa.size > MAX_MINIGAMES_POR_GRUPOS) mapa.delete(mapa.keys().next().value);
    }
}

// 🎰 CHANCES EXCLUSIVAS DO .APOSTAR
// Estas probabilidades não são compartilhadas com o duelo.
const APOSTAR_CHANCE_PERDER = 0.35;
const APOSTAR_CHANCE_DOBRAR = 0.45;
const APOSTAR_CHANCE_TRIPLICAR = 0.20;

// ⚔️ CHANCES EXCLUSIVAS DO .DUELO
// O duelo continua usando nível/XP para definir o vencedor.
const DUELO_CHANCE_MIN_VITORIA = 0.08;
const DUELO_CHANCE_MAX_VITORIA = 0.92;
const DUELO_BONUS_NIVEL = 0.84;
const DUELO_CHANCE_RECOMPENSA_PERDEDOR = 0.05;
const DUELO_RECOMPENSA_PERDEDOR = 10;

let timerJurosCartao = null;

const cooldownsComando = {};
const TEMPO_COOLDOWN_MS = 3000;

const removidosRecentes = {};
const aguardandoSelecaoAdd = {};
const MAX_SELECOES_ADD_PENDENTES = 500;
const TTL_SELECAO_ADD_MS = 5 * 60 * 1000;

// Map de id -> expiração substitui um timeout por mensagem enviada.
const mensagensIgnorarInterativo = new Map();
// Evita reprocessamento do mesmo evento/mensagem, sem criar um timeout por evento.
const mensagensProcessadas = new Map();
const TEMPO_DEDUP_MENSAGEM_MS = 5 * 60 * 1000;

function limparCachesTemporarios(agora = Date.now()) {
    for (const [id, registro] of cacheMensagens) {
        if (!registro || registro.expiraEm <= agora) cacheMensagens.delete(id);
    }
    for (const [id, registro] of cacheBuffersVisu) {
        if (!registro || registro.expiraEm <= agora || !Buffer.isBuffer(registro.buffer)) {
            cacheBuffersVisu.delete(id);
        }
    }
    for (const [chave, quando] of mensagensProcessadas) {
        if (agora - quando >= TEMPO_DEDUP_MENSAGEM_MS) mensagensProcessadas.delete(chave);
    }
    for (const [id, expiraEm] of mensagensIgnorarInterativo) {
        if (expiraEm <= agora) mensagensIgnorarInterativo.delete(id);
    }
    for (const [chave, pendente] of Object.entries(pendentesYouTube)) {
        if (!pendente || !pendente.expiraEm || pendente.expiraEm <= agora) delete pendentesYouTube[chave];
    }
    for (const [chave, quando] of Object.entries(cooldownsComando)) {
        if (!Number.isFinite(Number(quando)) || agora - Number(quando) > TEMPO_COOLDOWN_MS * 2) delete cooldownsComando[chave];
    }
    for (const [chave, estado] of Object.entries(aguardandoSelecaoAdd)) {
        if (!estado || !estado.expiraEm || estado.expiraEm <= agora) delete aguardandoSelecaoAdd[chave];
    }

    while (cacheMensagens.size > MAX_CACHE_MENSAGENS) cacheMensagens.delete(cacheMensagens.keys().next().value);
    while (mensagensProcessadas.size > MAX_MENSAGENS_PROCESSADAS) mensagensProcessadas.delete(mensagensProcessadas.keys().next().value);
    while (mensagensIgnorarInterativo.size > MAX_MENSAGENS_IGNORAR) mensagensIgnorarInterativo.delete(mensagensIgnorarInterativo.keys().next().value);

    let bytesVisu = 0;
    for (const registro of cacheBuffersVisu.values()) bytesVisu += registro?.buffer?.length || 0;
    while (cacheBuffersVisu.size > MAX_CACHE_VISU_ITENS || bytesVisu > MAX_CACHE_VISU_TOTAL_BYTES) {
        const idAntigo = cacheBuffersVisu.keys().next().value;
        if (idAntigo === undefined) break;
        bytesVisu -= cacheBuffersVisu.get(idAntigo)?.buffer?.length || 0;
        cacheBuffersVisu.delete(idAntigo);
    }
    while (Object.keys(pendentesYouTube).length > MAX_PENDENTES_YOUTUBE) {
        delete pendentesYouTube[Object.keys(pendentesYouTube)[0]];
    }
    while (Object.keys(aguardandoSelecaoAdd).length > MAX_SELECOES_ADD_PENDENTES) {
        delete aguardandoSelecaoAdd[Object.keys(aguardandoSelecaoAdd)[0]];
    }
}

function guardarMensagemCache(mensagem) {
    const id = mensagem?.key?.id;
    if (!id) return;
    cacheMensagens.delete(id);
    cacheMensagens.set(id, { mensagem, expiraEm: Date.now() + TTL_CACHE_MENSAGENS_MS });
    while (cacheMensagens.size > MAX_CACHE_MENSAGENS) cacheMensagens.delete(cacheMensagens.keys().next().value);
}

function guardarBufferVisu(id, registro) {
    if (!id || !Buffer.isBuffer(registro?.buffer)) return;
    // Uma mídia muito grande ainda pode ser encaminhada no fluxo atual, mas não
    // fica retida em RAM por duas horas no cache Anti-Delete.
    if (registro.buffer.length > MAX_CACHE_VISU_ITEM_BYTES) {
        console.warn(`[CACHE] Mídia de visualização única ignorada no cache (${Math.ceil(registro.buffer.length / 1048576)} MiB; limite ${MAX_CACHE_VISU_ITEM_BYTES / 1048576} MiB).`);
        return;
    }
    cacheBuffersVisu.delete(id);
    cacheBuffersVisu.set(id, { ...registro, expiraEm: Date.now() + TTL_CACHE_MENSAGENS_MS });
    limparCachesTemporarios();
}

function marcarMensagemIgnorar(id, ttlMs) {
    if (!id) return;
    mensagensIgnorarInterativo.delete(id);
    mensagensIgnorarInterativo.set(id, Date.now() + ttlMs);
    while (mensagensIgnorarInterativo.size > MAX_MENSAGENS_IGNORAR) {
        mensagensIgnorarInterativo.delete(mensagensIgnorarInterativo.keys().next().value);
    }
}

function guardarPendenciaYouTube(chave, video) {
    limparCachesTemporarios();
    if (!Object.prototype.hasOwnProperty.call(pendentesYouTube, chave) && Object.keys(pendentesYouTube).length >= MAX_PENDENTES_YOUTUBE) {
        delete pendentesYouTube[Object.keys(pendentesYouTube)[0]];
    }
    pendentesYouTube[chave] = { ...video, expiraEm: Date.now() + TTL_PENDENTE_YOUTUBE_MS };
}

const timerLimpezaCaches = setInterval(() => limparCachesTemporarios(), 60 * 1000);
timerLimpezaCaches.unref?.();

function mensagemJaProcessada(m) {
    const id = m?.key?.id;
    const remoteJid = m?.key?.remoteJid;
    if (!id || !remoteJid) return false;

    const chave = `${remoteJid}|${id}`;
    const agora = Date.now();
    const anterior = mensagensProcessadas.get(chave);
    if (anterior && agora - anterior < TEMPO_DEDUP_MENSAGEM_MS) return true;
    mensagensProcessadas.delete(chave);
    while (mensagensProcessadas.size >= MAX_MENSAGENS_PROCESSADAS) {
        mensagensProcessadas.delete(mensagensProcessadas.keys().next().value);
    }
    mensagensProcessadas.set(chave, agora);
    return false;
}
const temporizadoresInatividade = {};

const XP_MAX_LEVEL = 30;
const XP_MSG_INTERVALO = 5;
const XP_MIN_GANHO = 23;
const XP_MAX_GANHO = 55;
const PRECO_XP_10 = 40;
const PRECO_XP_20 = 80;
const PRECO_XP_POR_UNIDADE_ACIMA_20 = 10;

let jaExibiuMensagemSemInternet = false;

function criarDadosIniciaisBot() {
    return {
        botAtivo: true,
        modoTeste: false,
        motivoModoTeste: null,
        numeroDono: '558191334599',
        usuariosMutados: {},
        logTexto: "ArleyBot 4.3.4: comando .tapa com GIF aleatório da pasta gif/. Mantém boas-vindas, confirmação de saída, painel de saúde, prefixo por grupo, relatos de bugs e limpeza segura de temporários.",
        gruposAvisos: {},
        prefixosGrupos: {},
        bemVindoGrupos: {},
        antiSpamGrupos: {},
        // pg = aluguel pago; npg = não pago/bloqueado; gc = grupo gratuito.
        // Sem cadastro de status, o grupo permanece bloqueado por segurança.
        statusAluguelGrupos: {},
        // Só inclui grupos detectados no evento em que a própria conta do bot foi adicionada.
        gruposAguardandoAutorizacao: {},
        textoAviso: null,
        brincadeiras: {},
        xpStatus: {},
        economia: {},
        verQuemModificou: {},
        logsModificacoesGrupo: {},
        mensagensAleatorias: {},
        cadastrosBanco: {},
        conquistas: {},
        progressoJogadores: {},
        diarios: {},
        missoesJogadores: {},
        transacoes: {},
        temporadas: {},
        antiPornoGrupos: {},
        nfsw1Grupos: {},
        gifNsfwUsados: []
    };
}

async function lerDadosBot() {
    let conteudo;
    try {
        conteudo = await readFile(ARQUIVO_DADOS, 'utf8');
    } catch (erroLeitura) {
        if (erroLeitura?.code !== 'ENOENT') throw erroLeitura;
        const dadosIniciais = criarDadosIniciaisBot();
        await writeFile(ARQUIVO_DADOS, JSON.stringify(dadosIniciais, null, 2), 'utf8');
        return dadosIniciais;
    }

    let parsed;
    try {
        parsed = JSON.parse(conteudo);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('A raiz de dados.json precisa ser um objeto JSON.');
        }
    } catch (erroJson) {
        const backup = `${ARQUIVO_DADOS}.corrompido.${Date.now()}.bak`;
        // Não sobrescreve o arquivo danificado: preserva-o para recuperação manual.
        await rename(ARQUIVO_DADOS, backup);
        console.error(`[DADOS] ⚠️ dados.json estava inválido (${erroJson?.message || erroJson}). O arquivo original foi preservado em ${path.basename(backup)}; iniciando com dados vazios.`);
        const dadosIniciais = criarDadosIniciaisBot();
        await writeFile(ARQUIVO_DADOS, JSON.stringify(dadosIniciais, null, 2), 'utf8');
        return dadosIniciais;
    }

    if (parsed.botAtivo === undefined) parsed.botAtivo = true;
    if (!parsed.gruposAvisos || typeof parsed.gruposAvisos !== 'object') parsed.gruposAvisos = {};
    if (!parsed.prefixosGrupos || typeof parsed.prefixosGrupos !== 'object' || Array.isArray(parsed.prefixosGrupos)) parsed.prefixosGrupos = {};
    if (!parsed.bemVindoGrupos || typeof parsed.bemVindoGrupos !== 'object' || Array.isArray(parsed.bemVindoGrupos)) parsed.bemVindoGrupos = {};
    if (!parsed.antiSpamGrupos || typeof parsed.antiSpamGrupos !== 'object' || Array.isArray(parsed.antiSpamGrupos)) parsed.antiSpamGrupos = {};
    if (!parsed.statusAluguelGrupos || typeof parsed.statusAluguelGrupos !== 'object' || Array.isArray(parsed.statusAluguelGrupos)) parsed.statusAluguelGrupos = {};
    if (!parsed.gruposAguardandoAutorizacao || typeof parsed.gruposAguardandoAutorizacao !== 'object' || Array.isArray(parsed.gruposAguardandoAutorizacao)) parsed.gruposAguardandoAutorizacao = {};
    // Grupos antigos não são liberados automaticamente: somente o evento de entrada cria uma pendência.
    if (parsed.textoAviso === undefined) parsed.textoAviso = null;
    if (!parsed.usuariosMutados || typeof parsed.usuariosMutados !== 'object') parsed.usuariosMutados = {};
    if (!parsed.brincadeiras || typeof parsed.brincadeiras !== 'object') parsed.brincadeiras = {};
    if (!parsed.xpStatus || typeof parsed.xpStatus !== 'object') parsed.xpStatus = {};
    if (!parsed.economia || typeof parsed.economia !== 'object') parsed.economia = {};
    if (!parsed.verQuemModificou || typeof parsed.verQuemModificou !== 'object') parsed.verQuemModificou = {};
    if (!parsed.logsModificacoesGrupo || typeof parsed.logsModificacoesGrupo !== 'object') parsed.logsModificacoesGrupo = {};
    if (!parsed.mensagensAleatorias || typeof parsed.mensagensAleatorias !== 'object') parsed.mensagensAleatorias = {};
    if (!parsed.cadastrosBanco || typeof parsed.cadastrosBanco !== 'object') parsed.cadastrosBanco = {};
    if (!parsed.conquistas || typeof parsed.conquistas !== 'object') parsed.conquistas = {};
    if (!parsed.progressoJogadores || typeof parsed.progressoJogadores !== 'object') parsed.progressoJogadores = {};
    if (!parsed.diarios || typeof parsed.diarios !== 'object') parsed.diarios = {};
    if (!parsed.missoesJogadores || typeof parsed.missoesJogadores !== 'object') parsed.missoesJogadores = {};
    if (!parsed.transacoes || typeof parsed.transacoes !== 'object') parsed.transacoes = {};
    if (!parsed.temporadas || typeof parsed.temporadas !== 'object') parsed.temporadas = {};
    if (!parsed.antiPornoGrupos || typeof parsed.antiPornoGrupos !== 'object') parsed.antiPornoGrupos = {};
    if (!parsed.nfsw1Grupos || typeof parsed.nfsw1Grupos !== 'object') parsed.nfsw1Grupos = {};
    if (!Array.isArray(parsed.gifNsfwUsados)) parsed.gifNsfwUsados = [];

    // Migra registros antigos para o formato com status explícito.
    for (const [chave, registro] of Object.entries(parsed.cadastrosBanco)) {
        if (registro === true) {
            parsed.cadastrosBanco[chave] = {
                status: 'cadastrado',
                cadastradoEm: Date.now(),
                atualizadoEm: Date.now()
            };
        } else if (registro && typeof registro === 'object' && !registro.status) {
            registro.status = 'cadastrado';
            registro.atualizadoEm = registro.atualizadoEm || Date.now();
        }
    }

    return parsed;
}

let filaSalvamentoDados = Promise.resolve();

function salvarDadosBot(dados) {
    // Escrita serializada e atômica: evita que interrupções deixem dados.json
    // truncado e que o próximo início recrie o banco vazio.
    filaSalvamentoDados = filaSalvamentoDados
        .catch(() => {})
        .then(async () => {
            const temporario = `${ARQUIVO_DADOS}.tmp`;
            const conteudo = JSON.stringify(dados, null, 2);
            await writeFile(temporario, conteudo, 'utf8');
            await rename(temporario, ARQUIVO_DADOS);
        });
    return filaSalvamentoDados;
}



// ==============================
// 🎮 NOVOS SISTEMAS DA ECONOMIA
// ==============================
const RECOMPENSA_DAILY_BASE = 150;
const DAILY_MAX_STREAK_RECOMPENSA = 1500;
const VALOR_INICIAL_ECONOMIA = 100;

const LOJA_ITENS = {
    protecao: {
        nome: '🛡️ Proteção contra roubo',
        preco: 2000,
        descricao: 'Bloqueia 1 tentativa de roubo contra você. Depois de usada, precisa comprar outra.'
    },
    kitxp: {
        nome: '✨ Kit de XP',
        preco: 350,
        descricao: 'Concede +30 XP imediatamente.'
    },
    kitxp60: {
        nome: '🌟 Kit de XP Plus',
        preco: 650,
        descricao: 'Concede +60 XP imediatamente.'
    },
    kitxp100: {
        nome: '👑 Kit de XP Supremo',
        preco: 1000,
        descricao: 'Concede +100 XP imediatamente.'
    },
    titulo: {
        nome: '🏷️ Título VIP',
        preco: 5000,
        descricao: 'Desbloqueia o título visual "VIP" no seu perfil.'
    }
};

const DEFINICOES_CONQUISTAS = {
    cadastro: { nome: '🏦 Primeiro Cadastro', descricao: 'Fez seu primeiro cadastro no Banco.' },
    trabalho1: { nome: '💼 Primeiro Trabalho', descricao: 'Trabalhou pela primeira vez.' },
    trabalho10: { nome: '🛠️ Trabalhador', descricao: 'Trabalhou 10 vezes.' },
    rico10000: { nome: '💰 Rico', descricao: 'Chegou a R$ 10.000 no saldo.' },
    nivel10: { nome: '🌟 Veterano', descricao: 'Chegou ao nível 10.' },
    nivel30: { nome: '👑 Lenda', descricao: 'Chegou ao nível 30.' },
    daily7: { nome: '🔥 Constante', descricao: 'Manteve 7 dias de sequência no Daily.' },
    compra1: { nome: '🛒 Primeiro Cliente', descricao: 'Comprou seu primeiro item na loja.' },
    duelo10: { nome: '⚔️ Duelista', descricao: 'Participou de 10 duelos.' },
    temporada_top3: { nome: '🏆 Pódio', descricao: 'Terminou uma temporada entre os 3 primeiros.' }
};

const MISOES_DIARIAS = [
    { id: 'mensagens20', tipo: 'mensagens', alvo: 20, titulo: '💬 Envie 20 mensagens', recompensaDinheiro: 500, recompensaXP: 20 },
    { id: 'trabalho3', tipo: 'trabalhos', alvo: 3, titulo: '💼 Trabalhe 3 vezes', recompensaDinheiro: 700, recompensaXP: 25 },
    { id: 'comprar1', tipo: 'compras', alvo: 1, titulo: '🛒 Compre 1 item na loja', recompensaDinheiro: 600, recompensaXP: 20 },
    { id: 'pix1', tipo: 'pix', alvo: 1, titulo: '💸 Faça 1 PIX', recompensaDinheiro: 600, recompensaXP: 20 },
    { id: 'daily1', tipo: 'daily', alvo: 1, titulo: '🎁 Pegue sua recompensa diária', recompensaDinheiro: 400, recompensaXP: 15 },
    { id: 'duelo1', tipo: 'duelos', alvo: 1, titulo: '⚔️ Participe de 1 duelo', recompensaDinheiro: 800, recompensaXP: 30 }
];

function dataLocalBot() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
}

function ontemLocalBot() {
    const agora = new Date();
    agora.setDate(agora.getDate() - 1);
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(agora);
}

function temporadaAtualId() {
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit'
    }).formatToParts(new Date());
    const ano = partes.find(p => p.type === 'year')?.value || String(new Date().getFullYear());
    const mes = partes.find(p => p.type === 'month')?.value || String(new Date().getMonth() + 1).padStart(2, '0');
    return `${ano}-${mes}`;
}

function garantirEconomia(dados, chave) {
    if (!dados.economia) dados.economia = {};
    if (!dados.economia[chave]) {
        dados.economia[chave] = {
            dinheiro: VALOR_INICIAL_ECONOMIA,
            lastWork: 0,
            lastRob: 0,
            poupanca: 0,
            protecaoRoubo: 0,
            titulo: null,
            emprestimo: 0,
            cartaoCredito: {
                divida: 0,
                principal: 0,
                limite: 0,
                criadoEm: 0,
                jurosInicio: 0,
                proximoJuros: 0,
                parcelasTotais: 0,
                parcelasPagas: 0,
                valorParcela: 0,
                proximaParcela: 0,
                pagamentosEmDia: 0,
                aumentosLimite: 0
            }
        };
    }

    const conta = dados.economia[chave];
    if (!Number.isFinite(Number(conta.dinheiro))) conta.dinheiro = VALOR_INICIAL_ECONOMIA;
    if (!Number.isFinite(Number(conta.lastWork))) conta.lastWork = 0;
    if (!Number.isFinite(Number(conta.lastRob))) conta.lastRob = 0;
    if (!Number.isFinite(Number(conta.poupanca))) conta.poupanca = 0;
    if (!Number.isFinite(Number(conta.protecaoRoubo))) conta.protecaoRoubo = 0;
    if (conta.titulo === undefined) conta.titulo = null;
    if (!Number.isFinite(Number(conta.emprestimo))) conta.emprestimo = 0;
    if (!conta.cartaoCredito || typeof conta.cartaoCredito !== 'object') conta.cartaoCredito = {};
    const cartao = conta.cartaoCredito;
    if (!Number.isFinite(Number(cartao.divida))) cartao.divida = 0;
    if (!Number.isFinite(Number(cartao.principal))) cartao.principal = 0;
    if (!Number.isFinite(Number(cartao.limite)) || Number(cartao.limite) <= 0) cartao.limite = 1000;
    cartao.limite = Math.min(10000, Math.max(1000, Number(cartao.limite)));
    if (!Number.isFinite(Number(cartao.criadoEm))) cartao.criadoEm = 0;
    if (!Number.isFinite(Number(cartao.jurosInicio))) cartao.jurosInicio = 0;
    if (!Number.isFinite(Number(cartao.proximoJuros))) cartao.proximoJuros = 0;
    if (!Number.isFinite(Number(cartao.parcelasTotais))) cartao.parcelasTotais = 0;
    if (!Number.isFinite(Number(cartao.parcelasPagas))) cartao.parcelasPagas = 0;
    if (!Number.isFinite(Number(cartao.valorParcela))) cartao.valorParcela = 0;
    if (!Number.isFinite(Number(cartao.proximaParcela))) cartao.proximaParcela = 0;
    if (!Number.isFinite(Number(cartao.pagamentosEmDia))) cartao.pagamentosEmDia = 0;
    if (!Number.isFinite(Number(cartao.aumentosLimite))) cartao.aumentosLimite = 0;
    return conta;
}

const LIMITE_CARTAO_INICIAL = 1000;
const LIMITE_CARTAO_MAXIMO = 10000;
const AUMENTO_LIMITE_CARTAO = 500;
const CHANCE_AUMENTO_LIMITE_CARTAO = 0.40;
const PRAZO_CARTAO_MS = 5 * 60 * 1000;
const MAX_PARCELAS_CARTAO = 3;

function limiteCartaoPorNivel(nivel) {
    // Mantido apenas para compatibilidade com dados/comandos antigos.
    // O limite real agora fica salvo em cartaoCredito.limite e começa em R$ 1.000.
    return LIMITE_CARTAO_INICIAL;
}

function garantirLimiteCartao(conta) {
    if (!conta || typeof conta !== 'object') return LIMITE_CARTAO_INICIAL;
    if (!conta.cartaoCredito || typeof conta.cartaoCredito !== 'object') conta.cartaoCredito = {};
    const cartao = conta.cartaoCredito;
    if (!Number.isFinite(Number(cartao.limite)) || Number(cartao.limite) <= 0) cartao.limite = LIMITE_CARTAO_INICIAL;
    cartao.limite = Math.min(LIMITE_CARTAO_MAXIMO, Math.max(LIMITE_CARTAO_INICIAL, Number(cartao.limite)));
    return cartao.limite;
}

function registrarPagamentoEmDiaCartao(conta, foiEmDia) {
    const cartao = conta.cartaoCredito;
    if (!foiEmDia) return { aumento: 0, limite: garantirLimiteCartao(conta) };

    cartao.pagamentosEmDia = (Number(cartao.pagamentosEmDia) || 0) + 1;
    let aumento = 0;
    let novoLimite = garantirLimiteCartao(conta);

    if (novoLimite < LIMITE_CARTAO_MAXIMO && Math.random() < CHANCE_AUMENTO_LIMITE_CARTAO) {
        novoLimite = Math.min(LIMITE_CARTAO_MAXIMO, novoLimite + AUMENTO_LIMITE_CARTAO);
        cartao.limite = novoLimite;
        cartao.aumentosLimite = (Number(cartao.aumentosLimite) || 0) + 1;
        aumento = AUMENTO_LIMITE_CARTAO;
    }

    return { aumento, limite: novoLimite };
}

function atualizarJurosCartao(dados) {
    let alterou = false;
    const agora = Date.now();
    for (const [chave, conta] of Object.entries(dados.economia || {})) {
        garantirEconomia(dados, chave);
        const cartao = dados.economia[chave].cartaoCredito;
        garantirLimiteCartao(dados.economia[chave]);
        if (!(Number(cartao.divida) > 0) || !(Number(cartao.principal) > 0)) continue;
        // Parcelamentos têm vencimentos próprios de 5 em 5 minutos e não recebem
        // juros automáticos entre as parcelas.
        if (Number(cartao.parcelasTotais) > 0) continue;
        const limiteMaximo = Math.max(Number(cartao.principal) * 2, Number(cartao.principal));
        if (!cartao.jurosInicio || agora < Number(cartao.jurosInicio)) continue;
        if (!cartao.proximoJuros) cartao.proximoJuros = Number(cartao.jurosInicio);
        if (agora >= Number(cartao.proximoJuros) && Number(cartao.divida) < limiteMaximo) {
            const intervalos = Math.floor((agora - Number(cartao.proximoJuros)) / 5000) + 1;
            const aumento = Math.min(
                limiteMaximo - Number(cartao.divida),
                Number(cartao.divida) * 0.01 * intervalos
            );
            if (aumento > 0) {
                cartao.divida += aumento;
                cartao.divida = Math.min(cartao.divida, limiteMaximo);
                cartao.proximoJuros = Number(cartao.proximoJuros) + intervalos * 5000;
                registrarTransacao(dados, chave, 'juros_cartao', aumento, 'Juros do cartão de crédito');
                alterou = true;
            } else {
                cartao.proximoJuros = agora + 5000;
            }
        }
    }
    return alterou;
}


function garantirProgressoJogador(dados, chave) {
    if (!dados.progressoJogadores) dados.progressoJogadores = {};
    if (!dados.progressoJogadores[chave]) {
        dados.progressoJogadores[chave] = {
            mensagens: 0,
            trabalhos: 0,
            roubos: 0,
            compras: 0,
            pix: 0,
            duelos: 0,
            vitoriasDuelos: 0,
            protecoesUsadas: 0,
            xpGanho: 0
        };
    }
    const p = dados.progressoJogadores[chave];
    for (const campo of ['mensagens','trabalhos','roubos','compras','pix','duelos','vitoriasDuelos','protecoesUsadas','xpGanho']) {
        if (!Number.isFinite(Number(p[campo]))) p[campo] = 0;
        else p[campo] = Math.max(0, Number(p[campo]));
    }
    return p;
}

function registrarTransacao(dados, chave, tipo, valor, descricao) {
    if (!dados.transacoes) dados.transacoes = {};
    if (!dados.transacoes[chave]) dados.transacoes[chave] = [];
    dados.transacoes[chave].unshift({
        tipo,
        valor: Number(valor) || 0,
        descricao: String(descricao || ''),
        timestamp: Date.now()
    });
    dados.transacoes[chave] = dados.transacoes[chave].slice(0, 50);
}

function garantirTemporadaGrupo(dados, remoteJid) {
    if (!dados.temporadas) dados.temporadas = {};
    const atual = temporadaAtualId();
    let temp = dados.temporadas[remoteJid];
    let alterou = false;

    if (!temp) {
        temp = { id: atual, inicio: Date.now(), pontos: {}, historico: [] };
        dados.temporadas[remoteJid] = temp;
        alterou = true;
    }

    if (!temp.pontos) temp.pontos = {};
    if (!temp.historico) temp.historico = [];

    if (temp.id !== atual) {
        const rankingAnterior = Object.entries(temp.pontos)
            .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
            .slice(0, 3);

        const recompensas = [2000, 1200, 800];
        const vencedores = [];
        for (let i = 0; i < rankingAnterior.length; i++) {
            const [chave, pontos] = rankingAnterior[i];
            const conta = garantirEconomia(dados, chave);
            const recompensa = recompensas[i] || 500;
            conta.dinheiro += recompensa;
            registrarTransacao(dados, chave, 'temporada', recompensa, `Recompensa do ${i + 1}º lugar da temporada ${temp.id}`);
            if (!dados.conquistas) dados.conquistas = {};
            if (!dados.conquistas[chave]) dados.conquistas[chave] = {};
            if (!dados.conquistas[chave].temporada_top3) {
                dados.conquistas[chave].temporada_top3 = Date.now();
            }
            vencedores.push({ chave, pontos: Number(pontos) || 0, recompensa, lugar: i + 1 });
        }

        if (rankingAnterior.length) {
            temp.historico.unshift({
                id: temp.id,
                finalizadoEm: Date.now(),
                vencedores
            });
            temp.historico = temp.historico.slice(0, 12);
        }

        temp = { id: atual, inicio: Date.now(), pontos: {}, historico: temp.historico };
        dados.temporadas[remoteJid] = temp;
        alterou = true;
    }

    return { temp, alterou };
}

function adicionarPontosTemporada(dados, remoteJid, chave, pontos) {
    if (!remoteJid || !chave) return false;
    const resultado = garantirTemporadaGrupo(dados, remoteJid);
    const temp = resultado.temp;
    temp.pontos[chave] = (Number(temp.pontos[chave]) || 0) + Math.max(0, Number(pontos) || 0);
    return resultado.alterou;
}

function registrarMissao(dados, chave, tipo, quantidade = 1) {
    if (!dados.missoesJogadores) dados.missoesJogadores = {};
    const hoje = dataLocalBot();
    if (!dados.missoesJogadores[chave] || dados.missoesJogadores[chave].data !== hoje) {
        dados.missoesJogadores[chave] = { data: hoje, progresso: {}, concluidas: {}, xpPendente: 0 };
    }

    const estado = dados.missoesJogadores[chave];
    if (!Number.isFinite(Number(estado.xpPendente))) estado.xpPendente = 0;
    estado.progresso[tipo] = (Number(estado.progresso[tipo]) || 0) + Math.max(0, Number(quantidade) || 0);

    let concluiu = false;
    for (const missao of MISOES_DIARIAS) {
        if (missao.tipo !== tipo) continue;
        const progresso = Math.min(missao.alvo, Number(estado.progresso[tipo]) || 0);
        if (progresso >= missao.alvo && !estado.concluidas[missao.id]) {
            estado.concluidas[missao.id] = true;
            const conta = garantirEconomia(dados, chave);
            conta.dinheiro += missao.recompensaDinheiro;
            estado.xpPendente += missao.recompensaXP;
            registrarTransacao(dados, chave, 'missao', missao.recompensaDinheiro, `Recompensa: ${missao.titulo}`);
            concluiu = true;
        }
    }
    return concluiu;
}

function verificarConquistas(dados, remoteJid, chave) {
    if (!dados.conquistas) dados.conquistas = {};
    if (!dados.conquistas[chave]) dados.conquistas[chave] = {};
    const desbloqueadas = dados.conquistas[chave];
    const progresso = garantirProgressoJogador(dados, chave);
    const conta = garantirEconomia(dados, chave);
    const stats = dados.xpStatus?.[chave] || { xp: 0, nivel: 1 };
    const diario = dados.diarios?.[chave] || { streak: 0 };

    const condicoes = {
        cadastro: bancoCadastrado(dados, remoteJid, `${chave.split('_').slice(1).join('_')}@s.whatsapp.net`),
        trabalho1: progresso.trabalhos >= 1,
        trabalho10: progresso.trabalhos >= 10,
        rico10000: conta.dinheiro >= 10000,
        nivel10: Number(stats.nivel) >= 10,
        nivel30: Number(stats.nivel) >= 30,
        daily7: Number(diario.streak) >= 7,
        compra1: progresso.compras >= 1,
        duelo10: progresso.duelos >= 10
    };

    const novas = [];
    for (const [id, condicao] of Object.entries(condicoes)) {
        if (condicao && !desbloqueadas[id]) {
            desbloqueadas[id] = Date.now();
            novas.push(id);
        }
    }

    return novas;
}

function removerPontosTemporada(dados, remoteJid, chave) {
    const temp = garantirTemporadaGrupo(dados, remoteJid).temp;
    if (temp?.pontos) delete temp.pontos[chave];
}

function chaveCadastroBanco(remoteJid, senderCanonico) {
    return `${remoteJid}_${normalizarJid(senderCanonico)}`;
}

function obterRegistroCadastroBanco(dados, remoteJid, senderCanonico) {
    if (!dados) return null;
    if (!dados.cadastrosBanco) dados.cadastrosBanco = {};

    const chave = chaveCadastroBanco(remoteJid, senderCanonico);
    let registro = dados.cadastrosBanco[chave];

    // Recupera cadastros antigos quando o WhatsApp alternou entre JID/LID ou
    // versões anteriores salvaram o número com outra normalização. A migração
    // preserva os outros dados do jogador e não marca registros removidos como ativos.
    if (!registro) {
        const id = normalizarJid(senderCanonico);
        const candidatos = Object.entries(dados.cadastrosBanco).filter(([k]) =>
            k.startsWith(`${remoteJid}_`) && normalizarJid(k.slice(remoteJid.length + 1)) === id
        );
        const encontrado = candidatos.find(([, r]) => r === true || r?.status === 'cadastrado');
        if (encontrado) {
            registro = encontrado[1];
            dados.cadastrosBanco[chave] = registro;
            if (encontrado[0] !== chave) delete dados.cadastrosBanco[encontrado[0]];
        }
    }

    // Compatibilidade com versões antigas que gravavam apenas true.
    if (registro === true) {
        dados.cadastrosBanco[chave] = {
            status: 'cadastrado',
            cadastradoEm: Date.now(),
            atualizadoEm: Date.now()
        };
        return dados.cadastrosBanco[chave];
    }

    if (!registro) return null;

    if (typeof registro !== 'object') {
        dados.cadastrosBanco[chave] = {
            status: 'nao_cadastrado',
            atualizadoEm: Date.now()
        };
        return dados.cadastrosBanco[chave];
    }

    if (!registro.status) registro.status = 'nao_cadastrado';
    return registro;
}

function statusCadastroBanco(dados, remoteJid, senderCanonico) {
    return obterRegistroCadastroBanco(dados, remoteJid, senderCanonico)?.status || 'nao_cadastrado';
}

function bancoCadastrado(dados, remoteJid, senderCanonico) {
    return statusCadastroBanco(dados, remoteJid, senderCanonico) === 'cadastrado';
}

function registrarCadastroBanco(dados, remoteJid, senderCanonico) {
    if (!dados.cadastrosBanco) dados.cadastrosBanco = {};
    const chave = chaveCadastroBanco(remoteJid, senderCanonico);
    const anterior = dados.cadastrosBanco[chave];
    const agora = Date.now();
    const cadastroAtual = (anterior && typeof anterior === 'object') ? anterior : {};

    dados.cadastrosBanco[chave] = {
        ...cadastroAtual,
        status: 'cadastrado',
        cadastradoEm: cadastroAtual.cadastradoEm || agora,
        removidoEm: null,
        atualizadoEm: agora
    };

    return dados.cadastrosBanco[chave];
}

function removerCadastroBanco(dados, remoteJid, senderCanonico) {
    if (!dados.cadastrosBanco) dados.cadastrosBanco = {};
    const chave = chaveCadastroBanco(remoteJid, senderCanonico);
    const anterior = dados.cadastrosBanco[chave];
    const agora = Date.now();
    const cadastroAtual = (anterior && typeof anterior === 'object') ? anterior : {};

    dados.cadastrosBanco[chave] = {
        ...cadastroAtual,
        status: 'removido',
        removidoEm: agora,
        atualizadoEm: agora
    };

    return dados.cadastrosBanco[chave];
}

function resetarDadosUsuarioGrupo(dados, remoteJid, senderCanonico) {
    if (!dados) return;
    if (!dados.economia) dados.economia = {};
    if (!dados.xpStatus) dados.xpStatus = {};
    if (!dados.cadastrosBanco) dados.cadastrosBanco = {};
    if (!dados.conquistas) dados.conquistas = {};
    if (!dados.progressoJogadores) dados.progressoJogadores = {};
    if (!dados.diarios) dados.diarios = {};
    if (!dados.missoesJogadores) dados.missoesJogadores = {};
    if (!dados.transacoes) dados.transacoes = {};

    const chave = chaveCadastroBanco(remoteJid, senderCanonico);

    // RESET TOTAL DO PERFIL: cadastro, dinheiro, poupança, proteção, XP, nível,
    // conquistas, missões, sequência diária e extrato.
    delete dados.economia[chave];
    delete dados.xpStatus[chave];
    delete dados.conquistas[chave];
    delete dados.progressoJogadores[chave];
    delete dados.diarios[chave];
    delete dados.missoesJogadores[chave];
    delete dados.transacoes[chave];
    removerPontosTemporada(dados, remoteJid, chave);
    if (typeof duelosPendentes !== 'undefined') delete duelosPendentes[chave];
    removerCadastroBanco(dados, remoteJid, senderCanonico);
}


// Reseta apenas uma categoria do perfil de um membro de um GP, sem tocar nos demais dados.
function resetarCampoUsuarioGrupo(dados, remoteJid, senderCanonico, campo) {
    if (!dados) return;
    const chave = chaveCadastroBanco(remoteJid, senderCanonico);
    let conta;
    switch (campo) {
        case 'cadastro':
            removerCadastroBanco(dados, remoteJid, senderCanonico);
            return 'Cadastro no Banco desativado';
        case 'dinheiro':
            conta = garantirEconomia(dados, chave);
            conta.dinheiro = VALOR_INICIAL_ECONOMIA;
            conta.lastWork = 0;
            conta.lastRob = 0;
            return `Saldo e tempos de trabalho/roubo redefinidos (saldo inicial de R$ ${VALOR_INICIAL_ECONOMIA.toFixed(2)})`;
        case 'xp': {
            if (!dados.xpStatus) dados.xpStatus = {};
            const stats = dados.xpStatus[chave] || (dados.xpStatus[chave] = { xp: 0, nivel: 1, msgCount: 0 });
            stats.xp = 0;
            stats.nivel = 1;
            stats.msgCount = 0;
            return 'XP e nível redefinidos (Nível 1, 0 XP)';
        }
        case 'poupanca':
            conta = garantirEconomia(dados, chave);
            conta.poupanca = 0;
            return 'Poupança zerada';
        case 'protecao':
            conta = garantirEconomia(dados, chave);
            conta.protecaoRoubo = 0;
            return 'Proteção contra roubo removida';
        case 'emprestimo':
            conta = garantirEconomia(dados, chave);
            conta.emprestimo = 0;
            return 'Empréstimo zerado';
        case 'cartao':
            conta = garantirEconomia(dados, chave);
            conta.cartaoCredito = {
                divida: 0, principal: 0, limite: LIMITE_CARTAO_INICIAL,
                criadoEm: 0, jurosInicio: 0, proximoJuros: 0,
                parcelasTotais: 0, parcelasPagas: 0, valorParcela: 0,
                proximaParcela: 0, pagamentosEmDia: 0, aumentosLimite: 0
            };
            return 'Cartão de crédito e dívida redefinidos';
        case 'missoes':
            if (dados.missoesJogadores) delete dados.missoesJogadores[chave];
            if (dados.diarios) delete dados.diarios[chave];
            return 'Missões diárias e sequência redefinidas';
        case 'conquistas':
            if (dados.conquistas) delete dados.conquistas[chave];
            return 'Conquistas removidas';
        case 'estatisticas':
            if (dados.progressoJogadores) delete dados.progressoJogadores[chave];
            if (dados.transacoes) delete dados.transacoes[chave];
            if (dados.temporadas?.[remoteJid]?.pontos) delete dados.temporadas[remoteJid].pontos[chave];
            return 'Estatísticas, extrato e pontos da temporada redefinidos';
        default:
            throw new Error(`Categoria de reset desconhecida: ${campo}`);
    }
}

function normalizarJidCompleto(jid) {
    if (jid === null || jid === undefined) return '';
    let valor = String(jid).trim();
    if (!valor || valor === '[object Object]') return '';
    if (valor.includes('@')) {
        const indiceArroba = valor.indexOf('@');
        const local = valor.slice(0, indiceArroba).split(':')[0];
        const servidor = valor.slice(indiceArroba + 1).toLowerCase();
        if (!local || !servidor) return '';
        return `${local}@${servidor}`;
    }
    const local = valor.split(':')[0];
    const digitos = local.replace(/\D/g, '');
    return digitos.length >= 7 ? `${digitos}@s.whatsapp.net` : '';
}

function extrairJidsDeValor(valor) {
    if (typeof valor === 'string') return valor.trim() && valor.trim() !== '[object Object]' ? [valor.trim()] : [];
    if (!valor || typeof valor !== 'object') return [];
    return [
        valor.id, valor.jid, valor.phoneNumber, valor.phone_number,
        valor.lid, valor.pn, valor.remoteJid, valor.remoteJidAlt,
        valor.participant, valor.participantAlt, valor.senderPn
    ].filter(v => typeof v === 'string' && v.trim() && v.trim() !== '[object Object]');
}

async function eDono(m, sender, numeroDono, socket = null) {
    if (m?.key?.fromMe) return true;
    const numDono = String(numeroDono || '').replace(/\D/g, '');
    if (!numDono) return false;

    const valores = [
        sender,
        m?.key?.participant,
        m?.key?.remoteJid,
        m?.key?.participantAlt,
        m?.key?.remoteJidAlt,
        m?.key?.senderPn,
        m?.key?.participantPn,
        m?.key?.remoteJidPn
    ];
    const candidatos = [...new Set(valores.flatMap(extrairJidsDeValor).map(normalizarJidCompleto).filter(Boolean))];
    const numeroDoJid = jid => {
        const normalizado = normalizarJidCompleto(jid);
        if (!normalizado) return '';
        const servidor = normalizado.split('@')[1] || '';
        if (!['s.whatsapp.net', 'c.us'].includes(servidor)) return '';
        return normalizado.split('@')[0].replace(/\D/g, '');
    };

    if (candidatos.some(jid => numeroDoJid(jid) === numDono)) return true;

    const lidMapping = socket?.signalRepository?.lidMapping;
    if (lidMapping) {
        for (const candidato of candidatos) {
            if (!candidato.endsWith('@lid')) continue;
            try {
                if (typeof lidMapping.getPNForLID === 'function') {
                    const pn = await lidMapping.getPNForLID(candidato);
                    if (numeroDoJid(pn) === numDono) return true;
                }
            } catch (_) {}
        }
        try {
            if (typeof lidMapping.getLIDForPN === 'function') {
                const lidDono = normalizarJidCompleto(await lidMapping.getLIDForPN(`${numDono}@s.whatsapp.net`));
                if (lidDono && candidatos.includes(lidDono)) return true;
            }
        } catch (_) {}
    }
    return false;
}

function normalizarJid(jid) {
    if (!jid) return '';
    const base = String(jid).split(':')[0];
    return base.split('@')[0].replace(/\D/g, '') || base.split('@')[0];
}

function obterTextoMensagem(msg) {
    if (!msg) return '';
    let current = msg;
    for (let i = 0; i < 5; i++) {
        if (!current) break;
        if (current.ephemeralMessage?.message) { current = current.ephemeralMessage.message; continue; }
        if (current.viewOnceMessage?.message) { current = current.viewOnceMessage.message; continue; }
        if (current.viewOnceMessageV2?.message) { current = current.viewOnceMessageV2.message; continue; }
        if (current.viewOnceMessageV2Extension?.message) { current = current.viewOnceMessageV2Extension.message; continue; }
        if (current.documentWithCaptionMessage?.message) { current = current.documentWithCaptionMessage.message; continue; }
        if (current.editedMessage?.message) { current = current.editedMessage.message; continue; }
        break;
    }
    // Respostas de botões/listas entram no mesmo fluxo das confirmações por texto.
    const idBotao = current.buttonsResponseMessage?.selectedButtonId ||
        current.templateButtonReplyMessage?.selectedId ||
        current.listResponseMessage?.singleSelectReply?.selectedRowId;
    if (idBotao) return String(idBotao);

    const parametrosInterativos = current.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
        current.nativeFlowResponseMessage?.paramsJson;
    if (parametrosInterativos) {
        try {
            const parametros = typeof parametrosInterativos === 'string' ? JSON.parse(parametrosInterativos) : parametrosInterativos;
            const idSelecionado = parametros?.id || parametros?.selectedId || parametros?.button_id;
            if (idSelecionado) return String(idSelecionado);
        } catch (_) {}
    }

    return current.conversation ||
           current.extendedTextMessage?.text ||
           current.imageMessage?.caption ||
           current.videoMessage?.caption ||
           current.documentMessage?.caption ||
           '';
}



// Lê streams em partes (uma única concatenação) e interrompe downloads anormalmente grandes.
const LIMITE_BUFFER_MIDIA_BYTES = 64 * 1024 * 1024;
async function streamParaBufferLimitado(stream, limiteBytes = LIMITE_BUFFER_MIDIA_BYTES, nomeMidia = 'mídia') {
    const partes = [];
    let totalBytes = 0;
    for await (const chunk of stream) {
        totalBytes += chunk.length;
        if (totalBytes > limiteBytes) {
            partes.length = 0;
            throw new Error(`A ${nomeMidia} ultrapassou o limite de ${Math.ceil(limiteBytes / 1048576)} MiB para proteger a memória do celular.`);
        }
        partes.push(chunk);
    }
    return Buffer.concat(partes, totalBytes);
}

function prepararWebPParaFFmpeg(webpBuffer) {
    // Remove apenas EXIF/metadados do WebP antes do FFmpeg.
    // Alguns WebP enviados pelo WhatsApp têm EXIF que certos builds do
    // FFmpeg no Android não conseguem ignorar corretamente. Os dados VP8/
    // VP8L/VP8X/ANIM/ANMF permanecem intactos.
    try {
        if (!Buffer.isBuffer(webpBuffer) || webpBuffer.length < 16) return webpBuffer;
        if (webpBuffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
            webpBuffer.subarray(8, 12).toString('ascii') !== 'WEBP') return webpBuffer;

        const chunks = [];
        let offset = 12;
        let encontrouChunk = false;

        while (offset + 8 <= webpBuffer.length) {
            const header = webpBuffer.subarray(offset, offset + 4).toString('ascii');
            const size = webpBuffer.readUInt32LE(offset + 4);
            const end = offset + 8 + size;
            if (end > webpBuffer.length) return webpBuffer;

            encontrouChunk = true;
            if (header !== 'EXIF') {
                chunks.push(Buffer.from(webpBuffer.subarray(offset, end + (size % 2))));
            }
            offset = end + (size % 2);
        }

        if (!encontrouChunk || offset !== webpBuffer.length) return webpBuffer;

        const body = Buffer.concat(chunks);
        const riffSize = Buffer.alloc(4);
        riffSize.writeUInt32LE(body.length + 4, 0);

        return Buffer.concat([
            Buffer.from('RIFF', 'ascii'),
            riffSize,
            Buffer.from('WEBP', 'ascii'),
            body
        ]);
    } catch (erro) {
        console.error('⚠️ Não foi possível preparar o WebP para o FFmpeg:', erro?.message || erro);
        return webpBuffer;
    }
}

function analisarWebP(webpBuffer) {
    const resultado = {
        valido: false,
        animado: false,
        temVP8X: false,
        temANIM: false,
        quadros: 0,
        largura: 0,
        altura: 0
    };

    try {
        if (!Buffer.isBuffer(webpBuffer) || webpBuffer.length < 16) return resultado;
        if (webpBuffer.subarray(0, 4).toString('ascii') !== 'RIFF') return resultado;
        if (webpBuffer.subarray(8, 12).toString('ascii') !== 'WEBP') return resultado;

        resultado.valido = true;

        let offset = 12;
        while (offset + 8 <= webpBuffer.length) {
            const header = webpBuffer.subarray(offset, offset + 4).toString('ascii');
            const size = webpBuffer.readUInt32LE(offset + 4);
            const inicio = offset + 8;
            const fim = inicio + size;

            if (fim > webpBuffer.length) break;

            const data = webpBuffer.subarray(inicio, fim);

            if (header === 'VP8X' && data.length >= 10) {
                resultado.temVP8X = true;
                resultado.largura = data.readUIntLE(4, 3) + 1;
                resultado.altura = data.readUIntLE(7, 3) + 1;
                resultado.animado = (data[0] & 0x02) !== 0;
            } else if (header === 'ANIM') {
                resultado.temANIM = true;
            } else if (header === 'ANMF') {
                resultado.quadros++;
            }

            offset = fim + (size % 2);
        }

        resultado.animado = resultado.animado || (resultado.temANIM && resultado.quadros > 0);
        return resultado;
    } catch (erro) {
        return resultado;
    }
}

function adicionarExifFigurinha(webpBuffer, packname = NOME_PACK_FIGURINHA, author = AUTOR_PACK_FIGURINHA) {
    try {
        if (!Buffer.isBuffer(webpBuffer) || webpBuffer.length < 16) return webpBuffer;
        if (webpBuffer.subarray(0, 4).toString('ascii') !== 'RIFF' || webpBuffer.subarray(8, 12).toString('ascii') !== 'WEBP') return webpBuffer;

        const json = {
            'sticker-pack-id': 'arleybot-127',
            'sticker-pack-name': packname,
            'sticker-pack-publisher': author,
            'emojis': ['🤖', '🔥']
        };
        const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
        const exifHeader = Buffer.from([
            0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
            0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x16, 0x00, 0x00, 0x00
        ]);
        const exifData = Buffer.concat([exifHeader, jsonBuf]);
        exifData.writeUIntLE(jsonBuf.length, 14, 4);
        const exifSize = Buffer.alloc(4);
        exifSize.writeUInt32LE(exifData.length, 0);
        const exifChunk = Buffer.concat([
            Buffer.from('EXIF', 'ascii'), exifSize, exifData,
            exifData.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)
        ]);

        // IMPORTANTE: não reconstruir o VP8X de um WebP animado.
        // O VP8X original contém a flag de animação (0x02). Recriar esse
        // chunk pode transformar a animação em uma figurinha estática.
        const chunks = [];
        let offset = 12;
        let encontrouExif = false;
        let temVP8X = false;
        let ehAnimado = false;

        while (offset + 8 <= webpBuffer.length) {
            const header = webpBuffer.subarray(offset, offset + 4).toString('ascii');
            const size = webpBuffer.readUInt32LE(offset + 4);
            const endChunk = offset + 8 + size;
            if (endChunk > webpBuffer.length) return webpBuffer;

            const chunkCompleto = Buffer.from(webpBuffer.subarray(offset, endChunk + (size % 2)));
            const data = webpBuffer.subarray(offset + 8, endChunk);

            if (header === 'VP8X') {
                temVP8X = true;
                if (data.length >= 1 && (data[0] & 0x02)) ehAnimado = true;
            } else if (header === 'ANIM' || header === 'ANMF') {
                ehAnimado = true;
            }

            if (header === 'EXIF') {
                encontrouExif = true;
                // Substitui o EXIF antigo pelo novo, sem mexer nos demais chunks.
                chunks.push(exifChunk);
            } else {
                chunks.push(chunkCompleto);
            }

            offset = endChunk + (size % 2);
        }

        // Para WebP animado, preservamos byte a byte o VP8X/ANIM/ANMF e apenas
        // inserimos o EXIF. Isso mantém a animação intacta.
        if (ehAnimado || temVP8X) {
            if (!encontrouExif) {
                const indiceVP8X = chunks.findIndex(c => c.subarray(0, 4).toString('ascii') === 'VP8X');
                const posicao = indiceVP8X >= 0 ? indiceVP8X + 1 : 0;
                chunks.splice(posicao, 0, exifChunk);
            }

            const body = Buffer.concat(chunks);
            const riffSize = Buffer.alloc(4);
            riffSize.writeUInt32LE(body.length + 4, 0);
            return Buffer.concat([
                Buffer.from('RIFF', 'ascii'),
                riffSize,
                Buffer.from('WEBP', 'ascii'),
                body
            ]);
        }

        // WebP estático: aqui podemos criar VP8X para suportar EXIF.
        const vp8xData = Buffer.alloc(10);
        vp8xData[0] = 0x08; // EXIF
        vp8xData.writeUIntLE(511, 4, 3);
        vp8xData.writeUIntLE(511, 7, 3);
        const vp8xSize = Buffer.alloc(4);
        vp8xSize.writeUInt32LE(10, 0);
        const vp8xChunk = Buffer.concat([Buffer.from('VP8X', 'ascii'), vp8xSize, vp8xData]);

        const body = Buffer.concat([vp8xChunk, ...chunks, exifChunk]);
        const riffSize = Buffer.alloc(4);
        riffSize.writeUInt32LE(body.length + 4, 0);
        return Buffer.concat([
            Buffer.from('RIFF', 'ascii'), riffSize, Buffer.from('WEBP', 'ascii'), body
        ]);
    } catch (e) {
        console.error('❌ Erro ao adicionar créditos na figurinha:', e);
        // Nunca sacrificar uma animação só para colocar os créditos.
        return webpBuffer;
    }
}


// Adiciona os metadados do pack a WebP animado sem reconstruir nem reordenar
// VP8X/ANIM/ANMF. O EXIF é colocado depois dos quadros para preservar a animação.
function adicionarExifFigurinhaAnimada(webpBuffer, packname = NOME_PACK_FIGURINHA, author = AUTOR_PACK_FIGURINHA) {
    try {
        const infoOriginal = analisarWebP(webpBuffer);
        if (!infoOriginal.valido || !infoOriginal.animado || infoOriginal.quadros < 2) {
            return webpBuffer;
        }

        const jsonBuf = Buffer.from(JSON.stringify({
            'sticker-pack-id': 'arleybot-127',
            'sticker-pack-name': packname,
            'sticker-pack-publisher': author,
            'emojis': ['🤖', '🔥']
        }), 'utf8');
        const exifHeader = Buffer.from([
            0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
            0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x16, 0x00, 0x00, 0x00
        ]);
        const exifData = Buffer.concat([exifHeader, jsonBuf]);
        exifData.writeUIntLE(jsonBuf.length, 14, 4);
        const exifSize = Buffer.alloc(4);
        exifSize.writeUInt32LE(exifData.length, 0);
        const exifChunk = Buffer.concat([
            Buffer.from('EXIF', 'ascii'),
            exifSize,
            exifData,
            exifData.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)
        ]);

        const chunks = [];
        let offset = 12;
        while (offset + 8 <= webpBuffer.length) {
            const size = webpBuffer.readUInt32LE(offset + 4);
            const end = offset + 8 + size;
            const endPadded = end + (size % 2);
            if (end > webpBuffer.length || endPadded > webpBuffer.length) return webpBuffer;
            const chunkName = webpBuffer.subarray(offset, offset + 4).toString('ascii');
            // Remove any old EXIF metadata, leaving every other chunk byte-for-byte intact.
            if (chunkName !== 'EXIF') {
                chunks.push(Buffer.from(webpBuffer.subarray(offset, endPadded)));
            }
            offset = endPadded;
        }
        if (offset !== webpBuffer.length) return webpBuffer;

        // EXIF after the ANMF frames: do not place it between VP8X and ANIM.
        chunks.push(exifChunk);
        const body = Buffer.concat(chunks);
        const riffSize = Buffer.alloc(4);
        riffSize.writeUInt32LE(body.length + 4, 0);
        const finalBuffer = Buffer.concat([
            Buffer.from('RIFF', 'ascii'), riffSize,
            Buffer.from('WEBP', 'ascii'), body
        ]);

        const infoFinal = analisarWebP(finalBuffer);
        if (!infoFinal.valido || !infoFinal.animado ||
            infoFinal.quadros !== infoOriginal.quadros ||
            infoFinal.largura !== infoOriginal.largura ||
            infoFinal.altura !== infoOriginal.altura) {
            console.error('⚠️ Metadados de autor não aplicados: a validação da animação falhou.');
            return webpBuffer;
        }
        return finalBuffer;
    } catch (erro) {
        console.error('⚠️ Não foi possível adicionar autor à figurinha animada; mantendo a animação original:', erro?.message || erro);
        return webpBuffer;
    }
}

function desempacotarMensagem(msg) {
    let current = msg;
    for (let i = 0; i < 12 && current; i++) {
        if (current.ephemeralMessage?.message) { current = current.ephemeralMessage.message; continue; }
        if (current.viewOnceMessage?.message) { current = current.viewOnceMessage.message; continue; }
        if (current.viewOnceMessageV2?.message) { current = current.viewOnceMessageV2.message; continue; }
        if (current.viewOnceMessageV2Extension?.message) { current = current.viewOnceMessageV2Extension.message; continue; }
        if (current.documentWithCaptionMessage?.message) { current = current.documentWithCaptionMessage.message; continue; }
        if (current.editedMessage?.message) { current = current.editedMessage.message; continue; }
        if (current.message) { current = current.message; continue; }
        break;
    }
    return current || {};
}

function getMediaMessage(msg) {
    if (!msg) return null;

    const current = desempacotarMensagem(msg);

    if (current.imageMessage) return { type: 'image', msg: current.imageMessage };
    if (current.videoMessage) return { type: 'video', msg: current.videoMessage };
    if (current.audioMessage) return { type: 'audio', msg: current.audioMessage };
    if (current.stickerMessage) return { type: 'sticker', msg: current.stickerMessage };
    if (current.documentMessage) return { type: 'document', msg: current.documentMessage };

    // Alguns formatos do WhatsApp podem trazer a mídia dentro de uma
    // mensagem citada/contextualizada.
    const quoted = current.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quoted) return getMediaMessage(quoted);

    return null;
}

function extrairLegendaMensagem(msg) {
    const current = desempacotarMensagem(msg);
    return current.imageMessage?.caption ||
           current.videoMessage?.caption ||
           current.documentMessage?.caption ||
           '';
}

function encontrarMensagemViewOnce(msg) {
    let current = msg;

    for (let i = 0; i < 12 && current; i++) {
        if (current.viewOnceMessage?.message) return current.viewOnceMessage.message;
        if (current.viewOnceMessageV2?.message) return current.viewOnceMessageV2.message;
        if (current.viewOnceMessageV2Extension?.message) return current.viewOnceMessageV2Extension.message;

        if (current.ephemeralMessage?.message) {
            current = current.ephemeralMessage.message;
            continue;
        }

        if (current.message) {
            current = current.message;
            continue;
        }

        break;
    }

    return null;
}

function checkIsViewOnce(msg) {
    if (!msg) return false;
    if (encontrarMensagemViewOnce(msg)) return true;

    const media = getMediaMessage(msg);
    return !!(media && media.msg && media.msg.viewOnce);
}

function getTargetMedia(corpoMsg) {
    const media = getMediaMessage(corpoMsg);
    if (media) return media;

    const quoted = corpoMsg?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quoted) {
        const quotedMedia = getMediaMessage(quoted);
        if (quotedMedia) return quotedMedia;
    }
    return null;
}

// ==============================
// 🛡️ ANTIPORNO LOCAL (NSFWJS)
// A inferência roda no próprio Termux, sem enviar mídias a APIs externas.
// O modelo é carregado sob demanda para não consumir RAM quando a função está desligada.
// ==============================
const ANTIPORNO_LIMIAR = 0.82;
let promessaModeloAntiPorno = null;

async function carregarModeloAntiPorno() {
    if (!promessaModeloAntiPorno) {
        promessaModeloAntiPorno = (async () => {
            let tfModule;
            let nsfwModule;
            let pngModule;
            try {
                [tfModule, nsfwModule, pngModule] = await Promise.all([
                    import('@tensorflow/tfjs'),
                    import('nsfwjs'),
                    import('pngjs')
                ]);
            } catch (erro) {
                throw new Error('Dependências locais ausentes. No Termux, execute: npm install nsfwjs @tensorflow/tfjs pngjs. Detalhe: ' + (erro?.message || erro));
            }

            const tf = tfModule.default || tfModule;
            const nsfw = nsfwModule.default || nsfwModule;
            const loadModel = nsfwModule.load || nsfw.load;
            const PNG = pngModule.PNG || pngModule.default?.PNG;
            if (typeof loadModel !== 'function' || !PNG?.sync?.read) {
                throw new Error('Não consegui carregar as bibliotecas locais de classificação de imagem. Confira a instalação de nsfwjs, @tensorflow/tfjs e pngjs.');
            }

            tf.enableProdMode?.();
            await tf.setBackend('cpu');
            await tf.ready();
            const model = await loadModel('MobileNetV2');
            // Modelo carregado sob demanda; sem log rotineiro.
            return { tf, model, PNG };
        })().catch(erro => {
            promessaModeloAntiPorno = null;
            throw erro;
        });
    }
    return promessaModeloAntiPorno;
}

function obterMidiaDiretaAntiPorno(mensagem) {
    const root = desempacotarMensagem(mensagem);
    if (root.imageMessage) return { type: 'image', msg: root.imageMessage };
    if (root.videoMessage) return { type: 'video', msg: root.videoMessage };
    if (root.stickerMessage) return { type: 'sticker', msg: root.stickerMessage };
    return null;
}

async function classificarMidiaAntiPorno(buffer, tipo, segundos = 0) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { explicito: false, motivo: 'buffer vazio' };
    const { tf, model, PNG } = await carregarModeloAntiPorno();
    await mkdir(PASTA_TEMP, { recursive: true });

    const sufixo = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const entrada = path.join(PASTA_TEMP, `antiporno_${sufixo}.media`);
    await writeFile(entrada, buffer);

    try {
        let tempos = [0];
        const duracao = Number(segundos) || 0;
        if (tipo === 'video') {
            tempos = duracao > 3
                ? [0.5, Math.round((duracao / 2) * 10) / 10, Math.max(0.5, duracao - 0.5)]
                : [0, 1];
        } else if (tipo === 'sticker') {
            // Amostra poucos quadros para cobrir figurinhas animadas sem sobrecarregar o celular.
            tempos = [0, 0.7, 1.4];
        }
        tempos = [...new Set(tempos.map(n => Math.max(0, Number(n.toFixed(1)))))].slice(0, 3);

        let melhor = { classe: 'Neutral', pontuacao: 0, quadro: 0, previsoes: [] };
        for (let i = 0; i < tempos.length; i++) {
            const saidaPng = path.join(PASTA_TEMP, `antiporno_${sufixo}_${i}.png`);
            try {
                const args = ['-hide_banner', '-loglevel', 'error', '-y'];
                if (tempos[i] > 0 && (tipo === 'video' || tipo === 'sticker')) {
                    args.push('-ss', String(tempos[i]));
                }
                args.push('-i', entrada, '-frames:v', '1', '-vf', 'scale=512:512:force_original_aspect_ratio=decrease', '-f', 'image2', saidaPng);
                await executarProcesso('ffmpeg', args, { timeoutMs: 30000, maxBuffer: 256 * 1024 });

                const imagemPng = await readFile(saidaPng);
                const decodificada = PNG.sync.read(imagemPng);
                if (!decodificada.width || !decodificada.height || decodificada.width * decodificada.height > 512 * 512) {
                    continue;
                }
                const rgb = new Uint8Array(decodificada.width * decodificada.height * 3);
                for (let origem = 0, destino = 0; origem < decodificada.data.length; origem += 4) {
                    rgb[destino++] = decodificada.data[origem];
                    rgb[destino++] = decodificada.data[origem + 1];
                    rgb[destino++] = decodificada.data[origem + 2];
                }

                const tensor = tf.tensor3d(rgb, [decodificada.height, decodificada.width, 3], 'int32');
                let previsoes;
                try {
                    previsoes = await model.classify(tensor, 5);
                } finally {
                    tensor.dispose();
                }

                const adultos = (previsoes || []).filter(item => item.className === 'Porn' || item.className === 'Hentai');
                for (const item of adultos) {
                    const score = Number(item.probability) || 0;
                    if (score > melhor.pontuacao) {
                        melhor = { classe: item.className, pontuacao: score, quadro: i + 1, previsoes };
                    }
                }
                // Pontuação alta o bastante para evitar analisar quadros desnecessários.
                if (melhor.pontuacao >= ANTIPORNO_LIMIAR) break;
            } catch (erroQuadro) {
                console.warn(`[ANTIPORNO] Não consegui analisar o quadro ${i + 1}:`, erroQuadro?.message || erroQuadro);
            } finally {
                await unlink(saidaPng).catch(() => {});
            }
        }

        return {
            explicito: melhor.pontuacao >= ANTIPORNO_LIMIAR,
            classe: melhor.classe,
            pontuacao: melhor.pontuacao,
            quadro: melhor.quadro
        };
    } finally {
        await unlink(entrada).catch(() => {});
    }
}

function imprimirBannerArleyBot() {
    // Paleta discreta: vermelho vinho e cinza, sem o efeito arco-íris anterior.
    // ANSI nativo mantém o projeto sem dependências extras e funciona no Termux.
    if (process.env.NO_COLOR) return;
    const vinho = '\x1b[38;5;88m';
    const vermelhoQueimado = '\x1b[38;5;131m';
    const cinza = '\x1b[38;5;245m';
    const cinzaEscuro = '\x1b[38;5;240m';
    const reset = '\x1b[0m';
    console.log('');
    console.log(`${cinza}╔══════════════════════════════════════════════════╗${reset}`);
    console.log(`${cinza}║${reset}  ${vinho} █████╗ ██████╗ ██╗     ███████╗██╗   ██╗${reset}    ${cinza}║${reset}`);
    console.log(`${cinza}║${reset}  ${vinho}██╔══██╗██╔══██╗██║     ██╔════╝╚██╗ ██╔╝${reset}    ${cinza}║${reset}`);
    console.log(`${cinza}║${reset}  ${vermelhoQueimado}███████║██████╔╝██║     █████╗   ╚████╔╝ ${reset}    ${cinza}║${reset}`);
    console.log(`${cinza}║${reset}  ${vermelhoQueimado}██╔══██║██╔══██╗██║     ██╔══╝    ╚╔╝  ${reset}    ${cinza}║${reset}`);
    console.log(`${cinza}║${reset}  ${vinho}██║  ██║██║  ██║███████╗███████╗   ██║   ${reset}    ${cinza}║${reset}`);
    console.log(`${cinza}║${reset}  ${vinho}╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝   ╚═╝   ${reset}    ${cinza}║${reset}`);
    console.log(`${cinza}║${reset}                 A R L E Y ${cinzaEscuro}B O T${reset}                  ${cinza}║${reset}`);
    console.log(`${cinza}╚══════════════════════════════════════════════════╝${reset}`);
    console.log(`${cinza}  WhatsApp Bot${reset} ${cinzaEscuro}•${reset} ${vermelhoQueimado}v${ARLEYBOT_VERSION}${reset} ${cinzaEscuro}•${reset} ${cinza}Inicializando...${reset}`);
    console.log('');
}

if (process.env.ARLEYBOT_SUPERVISOR_CHILD !== '1') imprimirBannerArleyBot();

if (process.argv[2] !== '--bot') {
    // Impede dois `npm start` simultâneos de usar a mesma sessão do WhatsApp.
    // Uma segunda instância pode substituir o socket da primeira e causar ciclos de queda.
    const ARQUIVO_LOCK_SUPERVISOR = path.join(__dirname, '.arleybot-supervisor.pid');
    let lockSupervisorAdquirido = false;

    // Só podemos encerrar automaticamente um PID depois de confirmar que ele
    // executa este mesmo index.js. Um PID pode ter sido reutilizado pelo Android.
    function identificarProcessoArleyBot(pid) {
        try {
            try {
                process.kill(pid, 0);
            } catch (erroSonda) {
                if (erroSonda?.code === 'ESRCH') return 'encerrado';
                if (erroSonda?.code !== 'EPERM') return 'desconhecido';
            }

            const argumentos = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
                .split('\0').filter(Boolean);
            const diretorioProcesso = readlinkSync(`/proc/${pid}/cwd`);
            const executavel = path.basename(argumentos[0] || '');
            if (!/^node(?:js)?(?:\.exe)?$/i.test(executavel)) return 'outro';

            const scriptAtual = realpathSync(__filename);
            for (const argumento of argumentos.slice(1)) {
                if (!argumento || argumento.startsWith('-')) continue;
                try {
                    const caminhoArgumento = realpathSync(
                        path.isAbsolute(argumento) ? argumento : path.resolve(diretorioProcesso, argumento)
                    );
                    if (caminhoArgumento === scriptAtual) return 'arleybot';
                } catch (_) {}
            }
            return 'outro';
        } catch (_) {
            return 'desconhecido';
        }
    }

    const esperarSupervisor = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

    function removerLockSeContem(pidEsperado) {
        try {
            const pidNoLock = Number(readFileSync(ARQUIVO_LOCK_SUPERVISOR, 'utf8').trim()) || 0;
            if (pidNoLock === pidEsperado) unlinkSync(ARQUIVO_LOCK_SUPERVISOR);
        } catch (_) {}
    }

    // Um supervisor novo, iniciado durante a atualização, espera o anterior
    // liberar o lock. Assim não tenta encerrar o próprio supervisor que o criou.
    if (process.env.ARLEYBOT_WAIT_FOR_SUPERVISOR_LOCK === '1') {
        const prazoEsperaLock = Date.now() + 12000;
        while (existsSync(ARQUIVO_LOCK_SUPERVISOR) && Date.now() < prazoEsperaLock) {
            await esperarSupervisor(100);
        }
        if (existsSync(ARQUIVO_LOCK_SUPERVISOR)) {
            console.error('[SUPERVISOR] O supervisor anterior não liberou o lock em 12 segundos. Não vou abrir outra sessão do WhatsApp.');
            process.exit(1);
        }
        delete process.env.ARLEYBOT_WAIT_FOR_SUPERVISOR_LOCK;
    }

    try {
        if (existsSync(ARQUIVO_LOCK_SUPERVISOR)) {
            let pidExistente = 0;
            try { pidExistente = Number(readFileSync(ARQUIVO_LOCK_SUPERVISOR, 'utf8').trim()) || 0; } catch (_) {}

            // Um lock inválido ou com o PID desta nova execução é um lock antigo.
            if (!pidExistente || pidExistente === process.pid) {
                removerLockSeContem(pidExistente);
            } else {
                const identidadeInicial = identificarProcessoArleyBot(pidExistente);

                if (identidadeInicial === 'encerrado') {
                    // O processo já acabou; o arquivo restante é um lock órfão.
                    removerLockSeContem(pidExistente);
                } else if (identidadeInicial === 'outro') {
                    // O PID não corresponde a este script; nunca sinalizamos outro processo.
                    console.warn(`[SUPERVISOR] O PID ${pidExistente} não corresponde a esta cópia do ArleyBot. Limpando apenas o lock antigo, sem encerrar o processo.`);
                    removerLockSeContem(pidExistente);
                } else if (identidadeInicial === 'arleybot') {
                    console.warn(`[SUPERVISOR] Instância anterior do ArleyBot detectada (PID ${pidExistente}). Tentando encerrar com segurança antes de conectar esta instância...`);
                    try {
                        process.kill(pidExistente, 'SIGTERM');
                    } catch (erroEncerramento) {
                        console.error(`[SUPERVISOR] Não consegui encerrar a instância anterior (PID ${pidExistente}): ${erroEncerramento?.message || erroEncerramento}`);
                        console.error('[SUPERVISOR] Por segurança, esta instância não será iniciada. Feche a instância antiga no Termux e tente novamente.');
                        process.exit(1);
                    }

                    // O supervisor antigo precisa encerrar também seu processo-filho
                    // e liberar o lock antes que esta execução possa abrir o WhatsApp.
                    const prazoEncerramento = Date.now() + 7000;
                    let identidadeFinal = 'desconhecido';
                    while (Date.now() < prazoEncerramento) {
                        identidadeFinal = identificarProcessoArleyBot(pidExistente);
                        if (identidadeFinal === 'encerrado' || identidadeFinal === 'outro') break;
                        await esperarSupervisor(120);
                    }
                    identidadeFinal = identificarProcessoArleyBot(pidExistente);

                    if (identidadeFinal === 'arleybot' || identidadeFinal === 'desconhecido') {
                        console.error(`[SUPERVISOR] A instância anterior (PID ${pidExistente}) não foi liberada com segurança após 7 segundos.`);
                        console.error('[SUPERVISOR] Não vou abrir outra conexão para evitar duas instâncias usando a mesma sessão do WhatsApp.');
                        process.exit(1);
                    }

                    removerLockSeContem(pidExistente);
                } else {
                    console.error(`[SUPERVISOR] Não consegui confirmar com segurança a identidade do PID ${pidExistente}.`);
                    console.error('[SUPERVISOR] Não vou encerrar um processo desconhecido nem abrir uma segunda conexão. Verifique a instância antiga no Termux.');
                    process.exit(1);
                }
            }
        }

        // Exclusão mútua: se dois npm start ocorrerem juntos, só um adquire o lock.
        writeFileSync(ARQUIVO_LOCK_SUPERVISOR, String(process.pid), { flag: 'wx' });
        lockSupervisorAdquirido = true;
    } catch (erroLock) {
        if (erroLock?.code === 'EEXIST') {
            console.warn('[SUPERVISOR] Outra inicialização está assumindo o controle da sessão. Esta cópia será encerrada.');
            process.exit(0);
        }
        console.error('[SUPERVISOR] Não consegui proteger a sessão contra instâncias duplicadas:', erroLock?.message || erroLock);
        process.exit(1);
    }
    process.once('exit', () => {
        if (!lockSupervisorAdquirido) return;
        try {
            const pidNoArquivo = Number(readFileSync(ARQUIVO_LOCK_SUPERVISOR, 'utf8').trim()) || 0;
            if (pidNoArquivo === process.pid) unlinkSync(ARQUIVO_LOCK_SUPERVISOR);
        } catch (_) {}
    });

    let processoDoBot = null;
    let encerrandoSupervisor = false;
    let tentativasFalhaInicializacaoWorker = 0;
    let motivoReinicioPendente = null;
    let temporizadorReinicioSupervisor = null;
    let temporizadorEncerramentoForcado = null;
    let timerMonitorCodigo = null;
    let reinicioCompletoSupervisorPendente = false;
    let iniciandoSupervisorSubstituto = false;

    function processoEstaAtivo(processo) {
        return !!processo && processo.exitCode == null && processo.signalCode == null;
    }

    function iniciarSistema(motivo = 'inicialização') {
        if (encerrandoSupervisor) return;

        // Nunca abre dois sockets ao mesmo tempo com a mesma pasta de sessão.
        // A instância anterior precisa terminar antes de criar a nova.
        if (processoEstaAtivo(processoDoBot)) {
            motivoReinicioPendente = motivo;
            const processoAnterior = processoDoBot;
            // Reinício do processo executado sem log duplicado.
            try { processoAnterior.kill('SIGTERM'); } catch (erro) {
                console.error('[SUPERVISOR] ⚠️ Não foi possível encerrar a instância anterior:', erro?.message || erro);
            }

            if (temporizadorEncerramentoForcado) clearTimeout(temporizadorEncerramentoForcado);
            temporizadorEncerramentoForcado = setTimeout(() => {
                if (processoDoBot === processoAnterior && processoEstaAtivo(processoAnterior)) {
                    console.error('[SUPERVISOR] ⚠️ A instância anterior não encerrou a tempo; forçando o encerramento.');
                    try { processoAnterior.kill('SIGKILL'); } catch (_) {}
                }
            }, 5000);
            return;
        }

        if (temporizadorReinicioSupervisor) {
            clearTimeout(temporizadorReinicioSupervisor);
            temporizadorReinicioSupervisor = null;
        }

        // Evita mensagens repetidas do supervisor em cada reinício.
        const novoProcesso = spawn(
            process.argv[0],
            [process.argv[1], '--bot'],
            {
                stdio: 'inherit',
                env: { ...process.env, ARLEYBOT_SUPERVISOR_CHILD: '1' }
            }
        );
        processoDoBot = novoProcesso;
        let spawnConfirmado = false;

        novoProcesso.on('spawn', () => {
            spawnConfirmado = true;
            tentativasFalhaInicializacaoWorker = 0;
            // O estado conectado é informado pelo worker.
        });

        novoProcesso.on('error', (erro) => {
            console.error('[SUPERVISOR] ❌ Erro no processo do bot:', erro?.message || erro);
            // Um erro posterior de kill() não significa que o worker deixou de existir.
            // Só recuperamos por esta via se o evento 'spawn' nunca foi confirmado.
            if (spawnConfirmado || processoDoBot !== novoProcesso) return;

            processoDoBot = null;
            if (encerrandoSupervisor) return;
            if (temporizadorEncerramentoForcado) {
                clearTimeout(temporizadorEncerramentoForcado);
                temporizadorEncerramentoForcado = null;
            }
            tentativasFalhaInicializacaoWorker += 1;
            const esperaRecuperacao = Math.min(
                60_000,
                5_000 * (2 ** Math.min(tentativasFalhaInicializacaoWorker - 1, 4))
            );
            console.warn(`[SUPERVISOR] Nova tentativa de iniciar o worker em ${Math.ceil(esperaRecuperacao / 1000)}s (tentativa ${tentativasFalhaInicializacaoWorker}).`);
            if (temporizadorReinicioSupervisor) clearTimeout(temporizadorReinicioSupervisor);
            temporizadorReinicioSupervisor = setTimeout(() => {
                temporizadorReinicioSupervisor = null;
                if (!processoDoBot && !encerrandoSupervisor) iniciarSistema('recuperação após falha ao iniciar worker');
            }, esperaRecuperacao);
        });

        novoProcesso.on('exit', (codigo, sinal) => {
            const aindaEhProcessoAtual = processoDoBot === novoProcesso;
            if (aindaEhProcessoAtual) processoDoBot = null;
            if (temporizadorEncerramentoForcado) {
                clearTimeout(temporizadorEncerramentoForcado);
                temporizadorEncerramentoForcado = null;
            }
            // Encerramento normal do worker omitido do log de rotina.

            // Um processo antigo encerrando não pode afetar a instância atual.
            if (!aindaEhProcessoAtual) return;

            // Quando o próprio supervisor mudou junto com index.js, não basta
            // reiniciar só o worker: relançamos também o supervisor com o código novo.
            if (reinicioCompletoSupervisorPendente) {
                reinicioCompletoSupervisorPendente = false;
                iniciarSupervisorAtualizado();
                return;
            }

            if (encerrandoSupervisor) {
                process.exit(0);
                return;
            }

            // Em alterações de código, só iniciar novamente depois da liberação
            // real da sessão pelo processo anterior.
            if (motivoReinicioPendente) {
                const proximoMotivo = motivoReinicioPendente;
                motivoReinicioPendente = null;
                temporizadorReinicioSupervisor = setTimeout(() => {
                    temporizadorReinicioSupervisor = null;
                    if (!processoDoBot && !encerrandoSupervisor) iniciarSistema(proximoMotivo);
                }, 500);
                return;
            }

            // Recupera qualquer encerramento inesperado, inclusive SIGTERM.
            // A tentativa de recuperação ocorre sem poluir o terminal; erros seguem visíveis.
            temporizadorReinicioSupervisor = setTimeout(() => {
                temporizadorReinicioSupervisor = null;
                if (!processoDoBot && !encerrandoSupervisor) iniciarSistema('recuperação automática');
            }, 5000);
        });
    }

    function encerrarSupervisor(sinal) {
        if (encerrandoSupervisor) return;
        encerrandoSupervisor = true;
        motivoReinicioPendente = null;
        // Encerramento em andamento.
        if (timerMonitorCodigo) {
            clearInterval(timerMonitorCodigo);
            timerMonitorCodigo = null;
        }

        if (temporizadorReinicioSupervisor) {
            clearTimeout(temporizadorReinicioSupervisor);
            temporizadorReinicioSupervisor = null;
        }

        const processoAtual = processoDoBot;
        if (!processoEstaAtivo(processoAtual)) {
            process.exit(0);
            return;
        }

        try { processoAtual.kill('SIGTERM'); } catch (_) {}
        if (temporizadorEncerramentoForcado) clearTimeout(temporizadorEncerramentoForcado);
        temporizadorEncerramentoForcado = setTimeout(() => {
            if (processoEstaAtivo(processoAtual)) {
                try { processoAtual.kill('SIGKILL'); } catch (_) {}
            }
            process.exit(0);
        }, 4000);
    }

    // Reexecuta este arquivo como supervisor, não apenas como worker. O novo
    // processo espera o lock do processo antigo desaparecer antes de adquiri-lo.
    function iniciarSupervisorAtualizado() {
        if (iniciandoSupervisorSubstituto) return;
        iniciandoSupervisorSubstituto = true;

        let supervisorNovo;
        try {
            supervisorNovo = spawn(process.execPath, [__filename], {
                stdio: 'inherit',
                env: { ...process.env, ARLEYBOT_WAIT_FOR_SUPERVISOR_LOCK: '1' }
            });
        } catch (erroSpawn) {
            recuperarSupervisorAposFalhaDeAtualizacao(erroSpawn);
            return;
        }

        supervisorNovo.once('error', (erroSpawn) => {
            recuperarSupervisorAposFalhaDeAtualizacao(erroSpawn);
        });
        supervisorNovo.once('spawn', () => {
            console.log('[SUPERVISOR] Novo supervisor iniciado; encerrando a instância antiga para liberar o lock.');
            process.exit(0);
        });
    }

    function recuperarSupervisorAposFalhaDeAtualizacao(erro) {
        console.error('[SUPERVISOR] ❌ Não consegui iniciar o supervisor atualizado:', erro?.message || erro);
        console.error('[SUPERVISOR] Vou manter o supervisor atual e tentar recuperar o bot. Para aplicar as mudanças do supervisor, será necessário reiniciar o processo principal manualmente.');
        iniciandoSupervisorSubstituto = false;
        reinicioCompletoSupervisorPendente = false;
        encerrandoSupervisor = false;
        if (!timerMonitorCodigo) {
            timerMonitorCodigo = setInterval(() => {
                void verificarAlteracaoCodigo();
            }, 750);
            timerMonitorCodigo.unref?.();
        }
        iniciarSistema('recuperação após falha de atualização do supervisor');
    }

    function reiniciarSupervisorParaAtualizacao() {
        if (encerrandoSupervisor) return;
        // Não relança o supervisor como processo órfão: em Termux isso pode
        // devolver o prompt ao shell e fazer o worker perder a entrada do TTY.
        // O worker usa o arquivo atualizado; alterações no próprio supervisor
        // são aplicadas após um reinício manual e controlado de `npm start`.
        console.log('[SUPERVISOR] Reiniciando somente o worker para carregar o conteúdo atualizado e preservar o terminal...');
        reinicioCompletoSupervisorPendente = false;
        motivoReinicioPendente = null;
        iniciarSistema('atualização de código validada');
    }

    process.on('SIGINT', () => encerrarSupervisor('SIGINT'));
    process.on('SIGTERM', () => encerrarSupervisor('SIGTERM'));
    process.on('SIGHUP', () => encerrarSupervisor('SIGHUP'));

    // Hot reload fica desativado por padrão em produção para não derrubar
    // clientes por alterações externas inesperadas no arquivo. Para habilitar
    // explicitamente, defina ARLEYBOT_HOT_RELOAD=1 no ambiente do Termux.
    // Quando habilitado, comparamos o hash do CONTEÚDO; inode/ctime sozinhos
    // não são considerados mudança de código.
    const HOT_RELOAD_HABILITADO = process.env.ARLEYBOT_HOT_RELOAD === '1';
    function hashConteudoArquivo(conteudo) {
        return createHash('sha256').update(conteudo).digest('hex');
    }
    function assinaturaArquivo(estado) {
        return [estado.dev, estado.ino, estado.size, estado.mtimeMs, estado.ctimeMs].join(':');
    }

    let assinaturaArquivoAplicada = '';
    let hashConteudoAplicado = '';
    let assinaturaArquivoPendente = '';
    let hashConteudoFalhaSintaxe = '';
    let instanteAssinaturaPendente = 0;
    let verificacaoCodigoEmAndamento = false;
    const ESTABILIDADE_ARQUIVO_MS = 1500;

    try {
        assinaturaArquivoAplicada = assinaturaArquivo(statSync(__filename));
        hashConteudoAplicado = hashConteudoArquivo(readFileSync(__filename));
    } catch (erroStatInicial) {
        console.error('[HOT-RELOAD] Não consegui obter o estado inicial de index.js:', erroStatInicial?.message || erroStatInicial);
    }

    async function verificarAlteracaoCodigo() {
        if (!HOT_RELOAD_HABILITADO || encerrandoSupervisor || verificacaoCodigoEmAndamento) return;
        verificacaoCodigoEmAndamento = true;
        try {
            const estadoAtual = await stat(__filename);
            const assinaturaAtual = assinaturaArquivo(estadoAtual);

            if (assinaturaAtual === assinaturaArquivoAplicada) {
                assinaturaArquivoPendente = '';
                hashConteudoFalhaSintaxe = '';
                instanteAssinaturaPendente = 0;
                return;
            }

            if (assinaturaAtual !== assinaturaArquivoPendente) {
                assinaturaArquivoPendente = assinaturaAtual;
                instanteAssinaturaPendente = Date.now();
                return;
            }

            if (Date.now() - instanteAssinaturaPendente < ESTABILIDADE_ARQUIVO_MS) return;

            const conteudoAtual = await readFile(__filename);
            const hashAtual = hashConteudoArquivo(conteudoAtual);
            const estadoAposLeitura = await stat(__filename);
            const assinaturaAposLeitura = assinaturaArquivo(estadoAposLeitura);
            if (assinaturaAposLeitura !== assinaturaAtual) {
                assinaturaArquivoPendente = assinaturaAposLeitura;
                instanteAssinaturaPendente = Date.now();
                return;
            }

            // O arquivo pode receber novo inode/ctime sem que os bytes mudem.
            // Nesse caso atualizamos apenas a assinatura e NUNCA reiniciamos.
            if (hashAtual === hashConteudoAplicado) {
                assinaturaArquivoAplicada = assinaturaAposLeitura;
                assinaturaArquivoPendente = '';
                hashConteudoFalhaSintaxe = '';
                instanteAssinaturaPendente = 0;
                console.log('[HOT-RELOAD] Metadados de index.js mudaram, mas o conteúdo é idêntico; nenhum reinício necessário.');
                return;
            }

            if (hashAtual === hashConteudoFalhaSintaxe) return;
            try {
                await executarProcesso(process.execPath, ['--check', __filename], {
                    timeoutMs: 15000,
                    maxBuffer: 128 * 1024
                });
            } catch (erroSintaxe) {
                hashConteudoFalhaSintaxe = hashAtual;
                const detalhe = String(erroSintaxe?.message || erroSintaxe || 'erro de sintaxe').slice(-1200);
                console.error(`[HOT-RELOAD] O conteúdo mudou, mas a sintaxe não passou. O processo atual continuará ativo; corrija o arquivo e salve novamente.\n${detalhe}`);
                return;
            }

            // Confirma novamente o conteúdo após a validação para não reiniciar
            // durante uma gravação concorrente do MT Manager/editor.
            const conteudoConfirmado = await readFile(__filename);
            const hashConfirmado = hashConteudoArquivo(conteudoConfirmado);
            const estadoConfirmado = await stat(__filename);
            const assinaturaConfirmada = assinaturaArquivo(estadoConfirmado);
            if (hashConfirmado !== hashAtual || assinaturaConfirmada !== assinaturaAtual) {
                assinaturaArquivoPendente = assinaturaConfirmada;
                instanteAssinaturaPendente = Date.now();
                return;
            }

            assinaturaArquivoAplicada = assinaturaConfirmada;
            hashConteudoAplicado = hashConfirmado;
            assinaturaArquivoPendente = '';
            hashConteudoFalhaSintaxe = '';
            hashConteudoAvisadoSemReload = '';
            instanteAssinaturaPendente = 0;
            console.log('[HOT-RELOAD] Conteúdo de index.js realmente alterado e validado; reiniciando somente o worker.');
            reiniciarSupervisorParaAtualizacao();
        } catch (erroMonitor) {
            if (erroMonitor?.code !== 'ENOENT') {
                console.error('[HOT-RELOAD] Falha temporária ao verificar index.js:', erroMonitor?.message || erroMonitor);
            }
        } finally {
            verificacaoCodigoEmAndamento = false;
        }
    }

    iniciarSistema();
    if (HOT_RELOAD_HABILITADO) {
        timerMonitorCodigo = setInterval(() => {
            void verificarAlteracaoCodigo();
        }, 2000);
        timerMonitorCodigo.unref?.();
        console.log('[HOT-RELOAD] Ativado explicitamente; mudanças reais no conteúdo serão validadas antes do reinício.');
    } else {
        console.log('[HOT-RELOAD] Desativado por segurança. Para aplicar atualizações, faça uma reinicialização controlada do ArleyBot.');
    }

} else {

    const gruposAntiSpamAtivo = new Set();
    const historicoMensagens = {};

    // Autorização de grupos: grupos novos aguardam até 60 segundos por pg/gc.
    const temporizadoresAutorizacaoGrupo = new Map();
    const ultimosAvisosBloqueioGrupo = new Map();
    const solicitacoesConfiguracaoEmAndamento = new Set();
    const tentativasAvisoConfiguracaoDono = new Map();
    const temporizadoresRetryAvisoConfiguracaoDono = new Map();
    const expiracoesAutorizacaoEmAndamento = new Set();
    const PRAZO_AUTORIZACAO_GRUPO_MS = 60 * 1000;
    const INTERVALO_AVISO_BLOQUEIO_GRUPO_MS = 15 * 1000;
    
    // Ferramentas de terminal para o pareamento.
    // terminal:false impede o readline de chamar setRawMode() em processos
    // reiniciados pelo supervisor, evitando o crash EIO no Termux.
    // O modo de entrada continua baseado em linhas e aceita respostas digitadas.
    process.stdin.on('error', (erro) => {
        console.error('[TERMINAL] Entrada do terminal indisponível:', erro?.code || erro?.message || erro);
    });
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
    });
    rl.on('error', (erro) => {
        console.error('[TERMINAL] Interface de entrada interrompida:', erro?.code || erro?.message || erro);
    });
    const question = (texto) => new Promise((resolver) => {
        if (rl.closed || process.stdin.destroyed) {
            console.error('[TERMINAL] Não há entrada interativa disponível. Execute npm start em um terminal aberto para parear a sessão.');
            resolver('');
            return;
        }
        try {
            rl.question(texto, resolver);
        } catch (erroPergunta) {
            console.error('[TERMINAL] Não consegui ler a resposta:', erroPergunta?.code || erroPergunta?.message || erroPergunta);
            resolver('');
        }
    });

    function limparTemporizadorReciclagemSocket() {
        if (temporizadorReciclagemSocket) {
            clearTimeout(temporizadorReciclagemSocket);
            temporizadorReciclagemSocket = null;
        }
    }

    function encerrarWorkerPorSinal(sinal) {
        if (encerrandoWorker) return;
        encerrandoWorker = true;
        // Limpeza controlada antes de sair.
        encerrarProcessosExternos('SIGKILL');

        for (const timer of [temporizadorReconexao, temporizadorConexaoEstavel, temporizadorAberturaSocket, temporizadorRetryCodigo]) {
            if (timer) clearTimeout(timer);
        }
        temporizadorReconexao = null;
        temporizadorConexaoEstavel = null;
        temporizadorAberturaSocket = null;
        temporizadorRetryCodigo = null;
        limparTemporizadorReciclagemSocket();
        if (temporizadorVigilanciaSocket) {
            clearInterval(temporizadorVigilanciaSocket);
            temporizadorVigilanciaSocket = null;
        }
        if (timerJurosCartao) {
            clearInterval(timerJurosCartao);
            timerJurosCartao = null;
        }
        socketAberto = false;
        const socketAnterior = sockAtual;
        sockAtual = null;
        encerrarSocketAntigo(socketAnterior, `encerramento por ${sinal}`);
        try { rl.close(); } catch (_) {}

        // Primeiro drena as gravações pendentes e solicita uma última gravação
        // das credenciais. Depois deixamos o Node esvaziar as operações de disco
        // já iniciadas, em vez de chamar process.exit() imediatamente e cortá-las.
        // O temporizador sem referência é apenas um limite de emergência.
        const limiteSaida = setTimeout(() => process.exit(0), 4000);
        limiteSaida.unref?.();
        (async () => {
            try {
                const tarefasSessao = [];
                if (typeof salvarCredenciaisSessaoAtual === 'function') {
                    tarefasSessao.push(Promise.resolve().then(() => salvarCredenciaisSessaoAtual()));
                }
                tarefasSessao.push(Promise.resolve(promessaPersistenciaCredenciaisAtual));
                let limiteEspera;
                await Promise.race([
                    Promise.all(tarefasSessao.map(tarefa => Promise.resolve(tarefa).catch((erro) => {
                        console.warn('[SESSÃO] Não consegui finalizar uma gravação antes de sair:', erro?.message || erro);
                    }))),
                    new Promise(resolve => { limiteEspera = setTimeout(resolve, 2000); })
                ]);
                if (limiteEspera) clearTimeout(limiteEspera);
            } catch (erroFinalizacaoSessao) {
                console.warn('[SESSÃO] Encerramento seguro incompleto:', erroFinalizacaoSessao?.message || erroFinalizacaoSessao);
            } finally {
                // O processo sai naturalmente quando as operações pendentes terminarem.
                // O watchdog sem referência protege contra handles que não encerrem.
                process.exitCode = 0;
            }
        })();
    }

    process.once('SIGTERM', () => encerrarWorkerPorSinal('SIGTERM'));
    process.once('SIGINT', () => encerrarWorkerPorSinal('SIGINT'));

    // Um erro fatal não deixa o processo vivo em estado possivelmente inconsistente.
    // O supervisor já existente reinicia o worker sem apagar a autenticação.
    process.on('uncaughtException', (erro) => {
        console.error('[ERRO FATAL] Exceção não tratada; o supervisor reiniciará o bot:', erro?.stack || erro?.message || erro);
        encerrandoWorker = true;
        encerrarProcessosExternos('SIGKILL');
        for (const timer of [temporizadorReconexao, temporizadorConexaoEstavel, temporizadorAberturaSocket, temporizadorRetryCodigo, temporizadorReciclagemSocket]) {
            if (timer) clearTimeout(timer);
        }
        temporizadorReconexao = null;
        temporizadorConexaoEstavel = null;
        temporizadorAberturaSocket = null;
        temporizadorRetryCodigo = null;
        temporizadorReciclagemSocket = null;
        if (temporizadorVigilanciaSocket) { clearInterval(temporizadorVigilanciaSocket); temporizadorVigilanciaSocket = null; }
        if (timerJurosCartao) { clearInterval(timerJurosCartao); timerJurosCartao = null; }
        try { rl.close(); } catch (_) {}
        const socketFatal = sockAtual;
        sockAtual = null;
        socketAberto = false;
        encerrarSocketAntigo(socketFatal, 'exceção fatal');
        // Limite REFERENCIADO: o supervisor precisa receber a saída mesmo que algum handle sobreviva.
        const limiteFatal = setTimeout(() => process.exit(1), 3500);
        Promise.resolve()
            .then(() => typeof salvarCredenciaisSessaoAtual === 'function' ? salvarCredenciaisSessaoAtual() : undefined)
            .catch((erroSalvar) => console.warn('[SESSÃO] Falha ao salvar durante a recuperação fatal:', erroSalvar?.message || erroSalvar))
            .then(() => Promise.resolve(promessaPersistenciaCredenciaisAtual).catch(() => {}))
            .finally(() => {
                // Se houver operações de disco ainda abertas, elas poderão terminar antes
                // da saída natural; o limite sem referência encerra apenas se algo travar.
                process.exitCode = 1;
            });
    });

    process.on('unhandledRejection', (motivo) => {
        // Uma falha isolada de uma tarefa não deve desligar o bot inteiro sem supervisor.
        console.error('[ERRO ASSÍNCRONO] Promessa rejeitada sem tratamento; preservando o processo:', motivo?.stack || motivo?.message || motivo);
        if (!socketAberto && !encerrandoWorker && typeof agendarReconexao === 'function') {
            try { agendarReconexao('falha assíncrona com conexão fechada'); } catch (_) {}
        }
    });

    let reconexaoEmAndamento = false;
    let sockAtual = null;
    // Mantém acessível o estado da persistência para que um SIGINT/SIGTERM
    // não encerre o processo enquanto a gravação das credenciais ainda está ativa.
    let promessaPersistenciaCredenciaisAtual = Promise.resolve();
    let salvarCredenciaisSessaoAtual = null;
    let temporizadorReconexao = null;
    let temporizadorConexaoEstavel = null;
    let temporizadorAberturaSocket = null;
    let temporizadorRetryCodigo = null;
    let temporizadorReciclagemSocket = null;
    let temporizadorVigilanciaSocket = null;
    let socketAberto = false;
    const socketsEncerrados = new WeakSet();
    let encerrandoWorker = false;
    let tentativasReconexaoConsecutivas = 0;

    // Watchdog passivo: verifica apenas o estado real do WebSocket, sem criar
    // consultas periódicas adicionais ao WhatsApp. A reconexão normal continua
    // sendo dirigida pelo evento connection.update do Baileys.
    const INTERVALO_VIGILANCIA_SOCKET_MS = 15 * 1000;
    // A reciclagem fixa desconectava o bot mesmo quando a ligação estava saudável.
    // Desativada por padrão; o watchdog segue verificando o socket. Para reativar,
    // defina ARLEYBOT_SOCKET_RECYCLE_HOURS com um valor de 1 a 24.
    const HORAS_RECICLAGEM_CONFIG = Number(process.env.ARLEYBOT_SOCKET_RECYCLE_HOURS || 0);
    const HORAS_RECICLAGEM_SOCKET = Number.isFinite(HORAS_RECICLAGEM_CONFIG)
        ? Math.max(0, Math.min(24, HORAS_RECICLAGEM_CONFIG))
        : 0;
    const INTERVALO_RECICLAGEM_SOCKET_MS = HORAS_RECICLAGEM_SOCKET > 0
        ? HORAS_RECICLAGEM_SOCKET * 60 * 60 * 1000
        : 0;
    let substituicoesSessaoConsecutivas = 0;
    let inicioStartBotPromise = null;
    let modoConexaoForcado = null;
    let numeroPareamentoForcado = '';
    let trocarMetodoTerminal = null;
    let trocaManualEmAndamento = false;

    // Recebe comandos de troca de conexão somente quando o bot os habilita.
    rl.on('line', (linha) => {
        const handler = trocarMetodoTerminal;
        if (handler) {
            Promise.resolve(handler(linha.trim())).catch((erro) => {
                console.error('[CONEXÃO] ❌ Não foi possível trocar o método:', erro?.message || erro);
            });
        }
    });

    async function startBot() {
        if (inicioStartBotPromise) {
            // Pedido duplicado ignorado silenciosamente.
            return inicioStartBotPromise;
        }
        inicioStartBotPromise = startBotCore();
        try {
            return await inicioStartBotPromise;
        } finally {
            inicioStartBotPromise = null;
        }
    }

    // Mantém apenas os 3 backups de sessão mais recentes. Eles são úteis para
    // recuperação manual, mas não devem acumular indefinidamente no armazenamento.
    // Só remove diretórios com o prefixo exato da sessão do ArleyBot.
    const MAX_BACKUPS_SESSAO = 3;
    async function limparBackupsAntigosSessao() {
        try {
            const prefixo = `${path.basename(PASTA_SESSAO)}.backup-`;
            const entradas = await readdir(__dirname, { withFileTypes: true });
            const backups = entradas
                .filter(item => item.isDirectory() && item.name.startsWith(prefixo))
                .sort((a, b) => b.name.localeCompare(a.name));

            for (const backupAntigo of backups.slice(MAX_BACKUPS_SESSAO)) {
                await rm(path.join(__dirname, backupAntigo.name), { recursive: true, force: true }).catch(() => {});
            }
        } catch (_) {
            // A limpeza é auxiliar: uma falha nela nunca deve impedir o bot de iniciar.
        }
    }

    // Preserva uma cópia da sessão antiga quando o próprio WhatsApp a invalida.
    // Isso NÃO é executado em quedas normais de internet, que devem reutilizar o login.
    async function arquivarSessaoInvalida(motivo, estadoAuth = null) {
        try {
            if (!existsSync(PASTA_SESSAO)) {
                await mkdir(PASTA_SESSAO, { recursive: true });
                console.warn(`[SESSÃO] Pasta de autenticação recriada (${motivo}). Será necessário parear o WhatsApp.`);
                return true;
            }

            // IMPORTANTE: não confie apenas em creds.registered para decidir se
            // deve preservar a pasta. O WhatsApp pode rejeitar um pareamento incompleto
            // com 401 enquanto credenciais parciais ainda estão gravadas. Se deixarmos
            // esses arquivos em sessao_bot, a próxima tentativa reutilizará o mesmo estado
            // inválido e cairá novamente em 401. Arquive qualquer pasta não vazia.
            const arquivosSessao = await readdir(PASTA_SESSAO).catch((erro) => {
                if (erro?.code === 'ENOENT') return [];
                throw erro;
            });
            if (arquivosSessao.length === 0) {
                await mkdir(PASTA_SESSAO, { recursive: true });
                console.warn('[SESSÃO] A pasta de autenticação já estava vazia; pronta para novo pareamento.');
                return true;
            }

            const sufixo = new Date().toISOString().replace(/[:.]/g, '-');
            const pastaBackup = `${PASTA_SESSAO}.backup-${sufixo}`;
            await rename(PASTA_SESSAO, pastaBackup);
            await mkdir(PASTA_SESSAO, { recursive: true });
            await limparBackupsAntigosSessao();
            console.warn(`[SESSÃO] Arquivos da autenticação rejeitada foram preservados em ${path.basename(pastaBackup)}.`);
            if (estadoAuth?.creds?.registered !== true) {
                console.warn('[SESSÃO] A autenticação não estava marcada como registrada, mas os arquivos parciais também foram isolados para não repetir o 401.');
            }
            console.warn('[SESSÃO] A próxima tentativa usará uma pasta limpa. Escolha QR Code ou código de pareamento e conclua o vínculo no WhatsApp.');
            return true;
        } catch (erro) {
            console.error('[SESSÃO] ❌ Não consegui arquivar a autenticação inválida:', erro?.message || erro);
            console.error('[SESSÃO] Não vou apagar arquivos manualmente nem iniciar conexões concorrentes.');
            return false;
        }
    }

    // Fecha o socket anterior e remove seus listeners antes de abrir outro.
    // Assim eventos atrasados da sessão antiga não interferem no socket novo.
    function encerrarSocketAntigo(socket, motivo = 'reconexão') {
        if (!socket) return;
        try { socketsEncerrados.add(socket); } catch (_) {}
        try { socket.ev?.removeAllListeners?.(); } catch (_) {}
        try {
            if (typeof socket.end === 'function') socket.end(undefined);
            else if (typeof socket.ws?.close === 'function') socket.ws.close();
        } catch (erro) {
            console.warn(`[CONEXÃO] Não consegui encerrar completamente o socket anterior (${motivo}):`, erro?.message || erro);
        }
    }

    // Mantém a recuperação ativa mesmo quando a própria inicialização falha
    // por DNS/internet indisponível. Nunca cria dois temporizadores de reconexão.
    function agendarReconexao(motivo = 'conexão interrompida', esperaForcadaMs = null) {
        if (encerrandoWorker || trocaManualEmAndamento || temporizadorReconexao) return;

        // Invalida o estado primeiro e elimina TODOS os temporizadores da conexão anterior.
        // Sem isto, um timer de estabilidade antigo podia apagar a referência do timer novo.
        socketAberto = false;
        if (temporizadorConexaoEstavel) clearTimeout(temporizadorConexaoEstavel);
        if (temporizadorAberturaSocket) clearTimeout(temporizadorAberturaSocket);
        if (temporizadorRetryCodigo) clearTimeout(temporizadorRetryCodigo);
        temporizadorConexaoEstavel = null;
        temporizadorAberturaSocket = null;
        temporizadorRetryCodigo = null;
        limparTemporizadorReciclagemSocket();

        const socketAnterior = sockAtual;
        sockAtual = null;
        encerrarSocketAntigo(socketAnterior, motivo);
        reconexaoEmAndamento = true;
        tentativasReconexaoConsecutivas += 1;

        // Backoff limitado: 5, 10, 20, 40 e 60 segundos, com jitter positivo.
        // Isso evita martelar o servidor em ciclos persistentes de 428/rede instável.
        const limiteEsperaMs = 60_000;
        const esperaProgressiva = Math.min(
            limiteEsperaMs,
            5_000 * (2 ** Math.min(Math.max(0, tentativasReconexaoConsecutivas - 1), 4))
        );
        const esperaBase = Number.isFinite(esperaForcadaMs)
            ? Math.min(limiteEsperaMs, Math.max(0, esperaForcadaMs))
            : esperaProgressiva;
        const jitterMaximo = Number.isFinite(esperaForcadaMs)
            ? 0
            : Math.max(1, Math.floor(esperaBase * 0.2));
        const esperaMs = Math.min(limiteEsperaMs, esperaBase + (jitterMaximo ? Math.floor(Math.random() * jitterMaximo) : 0));
        console.warn(`[CONEXÃO] Reconexão agendada em ${Math.ceil(esperaMs / 1000)}s (tentativa ${tentativasReconexaoConsecutivas}). Motivo: ${motivo}`);

        if (!jaExibiuMensagemSemInternet) jaExibiuMensagemSemInternet = true;

        temporizadorReconexao = setTimeout(async () => {
            temporizadorReconexao = null;
            try {
                await startBot();
            } catch (erroReconexao) {
                console.error('[CONEXÃO] ❌ Falha ao iniciar a reconexão:', erroReconexao?.message || erroReconexao);
                agendarReconexao('a inicialização falhou');
            }
        }, esperaMs);
        temporizadorReconexao.unref?.();
    }

    // Monitor independente do evento connection.update. Só age quando a API expõe
    // um readyState confiável e ele confirma que o WebSocket não está aberto.
    // Não usa onWhatsApp() como ping: é uma consulta real à API e a falha de uma
    // sondagem não deve, por si só, derrubar uma sessão que ainda parece saudável.
    temporizadorVigilanciaSocket = setInterval(() => {
        const socket = sockAtual;
        if (encerrandoWorker || trocaManualEmAndamento || temporizadorReconexao || !socket || !socketAberto) return;

        const estadoWebSocket = obterReadyStateWebSocket(socket);
        // Algumas versões do Baileys não expõem o estado por uma propriedade pública.
        // Nesse caso, confiamos em connection.update e no timeout de abertura, em vez
        // de enviar consultas extras ou reiniciar com base em uma sondagem inconclusiva.
        if (typeof estadoWebSocket !== 'number') return;
        if (estadoWebSocket !== 1) {
            console.warn(`[CONEXÃO] ⚠️ O watchdog detectou WebSocket fora do estado OPEN (readyState=${estadoWebSocket}). Recriando a conexão...`);
            agendarReconexao('watchdog detectou WebSocket fechado');
        }
    }, INTERVALO_VIGILANCIA_SOCKET_MS);
    temporizadorVigilanciaSocket.unref?.();

    async function startBotCore() {
        // A inicialização duplicada nunca deve derrubar uma conexão atual saudável.
        // O agendador normal já invalida sockAtual antes de solicitar uma reconexão.
        if (sockAtual) {
            console.warn('[CONEXÃO] Inicialização duplicada ignorada: já existe um socket atribuído; a conexão atual foi preservada.');
            return;
        }
        if (encerrandoWorker) return;

        // Limpeza segura de backups antigos de autenticação; mantém os 3 últimos.
        await limparBackupsAntigosSessao();
        await mkdir(PASTA_TEMP, { recursive: true }).catch(() => {});
        await mkdir(PASTA_MIDIA, { recursive: true }).catch(() => {});

        let dadosGlobais = await lerDadosBot();
        if (!dadosGlobais.bemVindoGrupos || typeof dadosGlobais.bemVindoGrupos !== 'object' || Array.isArray(dadosGlobais.bemVindoGrupos)) dadosGlobais.bemVindoGrupos = {};
        const confirmacoesMorrer = new Map();
        if (!dadosGlobais.prefixosGrupos || typeof dadosGlobais.prefixosGrupos !== 'object') dadosGlobais.prefixosGrupos = {};
        if (!dadosGlobais.antiSpamGrupos || typeof dadosGlobais.antiSpamGrupos !== 'object') dadosGlobais.antiSpamGrupos = {};
        for (const [jidGrupoAntiSpam, ativoAntiSpam] of Object.entries(dadosGlobais.antiSpamGrupos)) {
            if (ativoAntiSpam && typeof jidGrupoAntiSpam === 'string' && jidGrupoAntiSpam.endsWith('@g.us')) {
                gruposAntiSpamAtivo.add(jidGrupoAntiSpam);
            }
        }
        await limparArquivosTemporariosAntigos();
        if (!dadosGlobais.botAtivo) {
            console.warn('[BOT] ⚠️ O bot está marcado como desligado em dados.json. Os comandos ficarão bloqueados até o dono enviar .ligar.');
        }

        // Detecta a ausência das credenciais ANTES de o Baileys criar a pasta/creds.json.
        // Se a sessão foi apagada, a preferência antiga não força o código de pareamento:
        // o menu QR/código aparece novamente. Reconexões de uma sessão existente mantêm a preferência.
        const haviaCredenciaisAntesDaCarga = existsSync(path.join(PASTA_SESSAO, 'creds.json'));
        const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO);
        if (encerrandoWorker) return;

        let modoConexao = state.creds.registered ? 'registrado' : 'pendente';
        let numeroPareamento = '';
        let codigoPareamentoSolicitado = false;
        const conexaoSalva = (state.creds.registered || !haviaCredenciaisAntesDaCarga)
            ? null
            : await lerConfigConexaoSalva();

        // Escolhe o método antes de criar o socket. A preferência fica em
        // conexao_bot.json, fora da sessão, para uma queda/reinicialização não
        // voltar a perguntar o método nem perder o número de pareamento.
        if (!state.creds.registered) {
            if (modoConexaoForcado) {
                modoConexao = modoConexaoForcado;
                numeroPareamento = numeroPareamentoForcado;
                modoConexaoForcado = null;
                numeroPareamentoForcado = '';
                console.log(modoConexao === 'qr'
                    ? '📷 Retomando conexão pelo QR Code...'
                    : '🔢 Retomando conexão pelo código de pareamento...');
            } else if (conexaoSalva) {
                modoConexao = conexaoSalva.modo;
                numeroPareamento = conexaoSalva.numero;
                console.log(modoConexao === 'qr'
                    ? '[CONEXÃO] Reutilizando QR Code como método salvo; não é necessário escolher novamente.'
                    : '[CONEXÃO] Reutilizando o número e o método de pareamento salvos; não é necessário escolher novamente.');
            } else {
                console.log("\n=============================================");
                const resposta = await question('❓ Escolha a forma de conexão:\n1 - Código de Pareamento (Recomendado)\n2 - QR Code\n👉 Digite 1 ou 2: ');

                if (resposta.trim() === '1') {
                    modoConexao = 'codigo';
                    numeroPareamento = (await question('📱 Digite seu número do WhatsApp com DDI (Ex: 558191334599): '))
                        .replace(/\D/g, '');
                    if (!/^\d{10,15}$/.test(numeroPareamento)) {
                        console.error('❌ Número inválido. Informe o número completo com DDI, somente números.');
                        try { rl.close(); } catch (_) {}
                        process.exitCode = 1;
                        return;
                    }
                } else if (resposta.trim() === '2') {
                    modoConexao = 'qr';
                    console.log('📷 Aguarde um momento para o QR Code ser exibido...');
                } else {
                    console.error('❌ Opção inválida. Execute novamente e escolha 1 ou 2.');
                    try { rl.close(); } catch (_) {}
                    process.exitCode = 1;
                    return;
                }
            }
            await salvarConfigConexaoSalva(modoConexao, numeroPareamento);
        }

        if (timerJurosCartao) clearInterval(timerJurosCartao);
        timerJurosCartao = setInterval(async () => {
            try {
                if (atualizarJurosCartao(dadosGlobais)) {
                    await salvarDadosBot(dadosGlobais);
                    // Atualizações automáticas gravadas sem gerar mensagens periódicas no Termux.
                }
            } catch (erroCartao) {
                console.error('[CARTÃO] Erro ao atualizar juros:', erroCartao?.message || erroCartao);
            }
        }, 5000);

        const loggerBaileys = pino({ level: 'silent' });
        const criarCacheChavesSignal = BaileysOptionalExports?.makeCacheableSignalKeyStore;
        const chavesSignalAuth = typeof criarCacheChavesSignal === 'function'
            ? criarCacheChavesSignal(state.keys, loggerBaileys)
            : state.keys;
        if (chavesSignalAuth === state.keys) {
            console.warn('[SESSÃO] Esta versão do Baileys não expõe makeCacheableSignalKeyStore; usando o armazenamento de chaves padrão.');
        }
        const sock = makeWASocket({
            logger: loggerBaileys,
            // Entrega mensagens recentes em cache quando o Baileys pede uma mensagem original para retry.
            // O cache é limitado e pode não conter mensagens antigas/evictadas.
            getMessage: async (key) => {
                const idMensagem = key?.id;
                if (!idMensagem) return undefined;
                const registroMensagem = cacheMensagens.get(idMensagem);
                if (!registroMensagem || registroMensagem.expiraEm <= Date.now()) {
                    if (registroMensagem) cacheMensagens.delete(idMensagem);
                    return undefined;
                }
                return registroMensagem.mensagem?.message || undefined;
            },
            // Cacheia leituras das chaves Signal quando a versão instalada oferece o recurso.
            // As gravações continuam indo para state.keys, fornecido pelo auth store.
            auth: {
                creds: state.creds,
                keys: chavesSignalAuth
            },
            // Não fixa manualmente o navegador anunciado ao WhatsApp.
            // Há relatos de ciclos de 428 que pararam ao remover a opção `browser`.
            // Reduz a divulgação automática de presença online ao conectar.
            markOnlineOnConnect: false,
            connectTimeoutMs: 45000,
            // Mantém consultas com tempo-limite explícito e pings mais frequentes.
            // No Baileys 7, syncFullHistory pode ser true por padrão; o bot não precisa
            // baixar todo o histórico para responder comandos e grupos.
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 20000,
            // Reduz o ritmo dos pedidos internos de retry após falhas de descriptografia.
            // Relatos no repositório do Baileys indicam que esta opção, junto de keepalive
            // mais curto, ajudou em ciclos de 428 após a conexão funcionar por algum tempo.
            retryRequestDelayMs: 5000,
            fireInitQueries: true,
            syncFullHistory: false
        });
        sockAtual = sock;
        socketAberto = false;

        // Persiste credenciais em fila, instalada ANTES de pedir o código/QR.
        // No pareamento, o WhatsApp pode emitir close (515) logo após creds.update;
        // a reconexão precisa esperar a gravação terminar para não ler uma sessão antiga.
        let promessaSalvarCredenciais = Promise.resolve();
        // O evento 'open' não deve executar duas inicializações se chegar duplicado
        // enquanto a primeira ainda aguarda I/O de credenciais.
        let processamentoEventoOpen = false;
        let eventoOpenConcluido = false;
        const enfileirarSalvamentoCredenciais = () => {
            // Serializa também a gravação final do encerramento com as atualizações
            // normais, para que duas gravações de creds.json não concorram.
            promessaSalvarCredenciais = promessaSalvarCredenciais
                .catch(() => {})
                .then(() => saveCreds());
            promessaPersistenciaCredenciaisAtual = promessaSalvarCredenciais;
            promessaSalvarCredenciais.catch((erroCredenciais) => {
                console.error('[SESSÃO] Não consegui salvar as credenciais atualizadas:', erroCredenciais?.message || erroCredenciais);
            });
            return promessaSalvarCredenciais;
        };
        salvarCredenciaisSessaoAtual = enfileirarSalvamentoCredenciais;
        sock.ev.on('creds.update', () => {
            if (sockAtual !== sock) return;
            void enfileirarSalvamentoCredenciais();
        });

        // Evita ficar silenciosamente preso em "conectando" para sempre.
        // O prazo é maior que connectTimeoutMs; se não houver open/close, recria o socket.
        if (temporizadorAberturaSocket) clearTimeout(temporizadorAberturaSocket);
        temporizadorAberturaSocket = setTimeout(() => {
            if (sockAtual !== sock || socketAberto || socketsEncerrados.has(sock)) return;
            console.error('[CONEXÃO] ⏱️ O WhatsApp não confirmou a conexão em 75 segundos. Vou descartar o socket antigo e tentar novamente.');
            agendarReconexao('tempo limite esperando a conexão abrir');
        }, 75000);

        if (!state.creds.registered) {
            const handlerTrocaMetodo = async (entrada) => {
                if (!entrada || trocaManualEmAndamento) return;
                const partes = entrada.trim().split(/\s+/);
                const escolha = (partes[0] || '').toLowerCase().replace(/^\//, '');
                if (!['1', '2', 'qr', 'qrcode', 'codigo', 'código', 'pareamento'].includes(escolha)) return;

                const novoModo = ['2', 'qr', 'qrcode'].includes(escolha) ? 'qr' : 'codigo';
                if (novoModo === modoConexao) {
                    console.log(`ℹ️ O método atual já é ${novoModo === 'qr' ? 'QR Code' : 'código de pareamento'}.`);
                    return;
                }

                let novoNumero = '';
                if (novoModo === 'codigo') {
                    novoNumero = (partes[1] || '').replace(/\D/g, '');
                    if (!novoNumero) {
                        trocarMetodoTerminal = null;
                        novoNumero = (await question('📱 Número com DDI para o código de pareamento: ')).replace(/\D/g, '');
                        if (sockAtual === sock && !trocaManualEmAndamento) trocarMetodoTerminal = handlerTrocaMetodo;
                    }
                    if (!/^\d{10,15}$/.test(novoNumero)) {
                        console.error('❌ Número inválido. Use DDI + número, somente dígitos.');
                        return;
                    }
                }

                console.log(`🔄 Alterando para ${novoModo === 'qr' ? 'QR Code' : 'código de pareamento'} sem reiniciar o Termux...`);
                await salvarConfigConexaoSalva(novoModo, novoNumero);
                trocaManualEmAndamento = true;
                trocarMetodoTerminal = null;
                if (temporizadorReconexao) {
                    clearTimeout(temporizadorReconexao);
                    temporizadorReconexao = null;
                }
                if (temporizadorConexaoEstavel) {
                    clearTimeout(temporizadorConexaoEstavel);
                    temporizadorConexaoEstavel = null;
                }
                if (temporizadorAberturaSocket) {
                    clearTimeout(temporizadorAberturaSocket);
                    temporizadorAberturaSocket = null;
                }
                if (temporizadorRetryCodigo) {
                    clearTimeout(temporizadorRetryCodigo);
                    temporizadorRetryCodigo = null;
                }
                limparTemporizadorReciclagemSocket();
                socketAberto = false;
                modoConexaoForcado = novoModo;
                numeroPareamentoForcado = novoNumero;
                if (sockAtual === sock) sockAtual = null;
                try {
                    if (typeof sock.end === 'function') sock.end();
                    else if (sock.ws && typeof sock.ws.close === 'function') sock.ws.close();
                } catch (_) {}
                await delay(800);
                reconexaoEmAndamento = false;
                trocaManualEmAndamento = false;
                await startBot();
            };
            trocarMetodoTerminal = handlerTrocaMetodo;
            console.log('⌨️ Durante a conexão, digite 2 ou qr para QR Code; digite 1 ou codigo para código de pareamento.');
        } else {
            trocarMetodoTerminal = null;
        }

        // Pede o código uma única vez quando o evento QR confirma que o socket está pronto.
        const solicitarCodigoPareamento = async () => {
            if (modoConexao !== 'codigo' || codigoPareamentoSolicitado || state.creds.registered || sockAtual !== sock || socketsEncerrados.has(sock)) return;
            codigoPareamentoSolicitado = true;
            try {
                const codigo = await sock.requestPairingCode(numeroPareamento);
                if (temporizadorRetryCodigo) {
                    clearTimeout(temporizadorRetryCodigo);
                    temporizadorRetryCodigo = null;
                }
                console.log('\n==========================================');
                console.log(`🔢 SEU CÓDIGO DE PAREAMENTO: ${codigo}`);
                console.log('==========================================');
                console.log('📱 No WhatsApp: Configurações → Dispositivos conectados → Conectar dispositivo → Conectar com número de telefone.');
                console.log('==========================================\n');
            } catch (erroPareamento) {
                codigoPareamentoSolicitado = false;
                console.error('❌ Erro ao pedir código de pareamento:', erroPareamento?.message || erroPareamento);
                console.error('💡 Vou aguardar 3,5 segundos antes de tentar novamente, sem fazer pedidos simultâneos.');
                if (temporizadorRetryCodigo) clearTimeout(temporizadorRetryCodigo);
                const timerRetryAtual = setTimeout(() => {
                    if (temporizadorRetryCodigo === timerRetryAtual) temporizadorRetryCodigo = null;
                    if (sockAtual === sock && !socketsEncerrados.has(sock) && !state.creds.registered && modoConexao === 'codigo') {
                        solicitarCodigoPareamento().catch((erro) => {
                            console.warn('[PAREAMENTO] Nova tentativa falhou:', erro?.message || erro);
                        });
                    }
                }, 3500);
                temporizadorRetryCodigo = timerRetryAtual;
                temporizadorRetryCodigo.unref?.();
            }
        };

        // Registra o evento imediatamente após criar o socket para não perder
        // o primeiro QR/código enquanto o restante do bot prepara os comandos.
        sock.ev.on('connection.update', async ({ qr }) => {
            if (!qr || sockAtual !== sock || socketsEncerrados.has(sock)) return;

            if (modoConexao === 'codigo' && !state.creds.registered) {
                await solicitarCodigoPareamento();
                return;
            }

            if (modoConexao === 'qr' || modoConexao === 'pendente') {
                try {
                    console.log('\n📷 QR CODE DO WHATSAPP — escaneie em Dispositivos conectados:');
                    const geradorQR = qrcode?.generate ? qrcode : qrcode?.default;
                    if (!geradorQR || typeof geradorQR.generate !== 'function') {
                        throw new Error('A dependência qrcode-terminal não disponibilizou a função generate.');
                    }
                    geradorQR.generate(qr, { small: true });
                    console.log('\n📱 WhatsApp → Dispositivos conectados → Conectar dispositivo.\n');
                } catch (erroQR) {
                    console.error('❌ Não foi possível desenhar o QR Code no terminal:', erroQR?.message || erroQR);
                    console.error('💡 No Termux, execute: npm install qrcode-terminal');
                    console.error('💡 Se o QR ficar ilegível, aumente a largura do terminal.');
                }
            }
        });

        // No modo código, requestPairingCode será chamado apenas quando chegar o evento QR,
        // sinal de que o socket está pronto; isso evita uma chamada prematura.

        // Marca TODAS as mensagens produzidas pelo bot. Assim, quando o Baileys
        // emitir o próprio envio em messages.upsert, ele será ignorado e não
        // poderá disparar novamente menus, respostas ou comandos interativos.
        const sendMessageOriginal = sock.sendMessage.bind(sock);
        const historicoSaidasPorChat = new Map();
        const historicoSaidasRepetidas = new Map();
        let reinicioAutomaticoSpamEmAndamento = false;
        const JANELA_CONTROLE_SPAM_MS = 15000;
        const LIMITE_TEXTO_REPETIDO_AUTO = 8;
        const LIMITE_ENVIO_CHAT_AUTO = 35;

        async function acionarReinicioAutomaticoPorSpam(remoteJid, motivo) {
            if (reinicioAutomaticoSpamEmAndamento) return;
            reinicioAutomaticoSpamEmAndamento = true;
            console.error(`[ANTI-SPAM AUTOMÁTICO] 🚨 ${motivo}. Bloqueando novos envios e reiniciando o bot.`);
            try {
                await writeFile(ARQUIVO_AVISO_RESTART, JSON.stringify({
                    remoteJid,
                    motivo: 'proteção automática contra spam',
                    criadoEm: Date.now()
                }, null, 2), 'utf8');
            } catch (erroAviso) {
                console.error('[ANTI-SPAM AUTOMÁTICO] Não consegui salvar o aviso de retorno:', erroAviso?.message || erroAviso);
            }
            setTimeout(() => process.exit(1), 250);
        }

        sock.sendMessage = async (...args) => {
            if (reinicioAutomaticoSpamEmAndamento) {
                throw new Error('Envio bloqueado pela proteção automática contra spam; reiniciando o ArleyBot.');
            }

            const destinoSaida = String(args[0] || '');
            const conteudoSaida = args[1] && typeof args[1] === 'object' ? args[1] : {};
            const textoSaida = String(conteudoSaida.text || conteudoSaida.caption || '').replace(/\s+/g, ' ').trim();
            if (destinoSaida && textoSaida.length >= 3 && !conteudoSaida.edit) {
                const agoraSaida = Date.now();
                const recentesChat = (historicoSaidasPorChat.get(destinoSaida) || [])
                    .filter(ts => agoraSaida - ts <= 10000);
                recentesChat.push(agoraSaida);
                historicoSaidasPorChat.set(destinoSaida, recentesChat);

                const chaveRepetida = `${destinoSaida}|${textoSaida.slice(0, 500)}`;
                const repeticoes = (historicoSaidasRepetidas.get(chaveRepetida) || [])
                    .filter(ts => agoraSaida - ts <= JANELA_CONTROLE_SPAM_MS);
                repeticoes.push(agoraSaida);
                historicoSaidasRepetidas.set(chaveRepetida, repeticoes);

                if (repeticoes.length >= LIMITE_TEXTO_REPETIDO_AUTO) {
                    await acionarReinicioAutomaticoPorSpam(destinoSaida, `o mesmo texto seria enviado ${repeticoes.length} vezes em ${Math.round(JANELA_CONTROLE_SPAM_MS / 1000)} segundos`);
                    throw new Error('Envio bloqueado pela proteção automática contra spam.');
                }
                if (recentesChat.length >= LIMITE_ENVIO_CHAT_AUTO) {
                    await acionarReinicioAutomaticoPorSpam(destinoSaida, `${recentesChat.length} mensagens de texto destinadas ao mesmo chat em 10 segundos`);
                    throw new Error('Envio bloqueado pela proteção automática contra spam.');
                }

                // Mantém os mapas limitados quando o bot conversa com muitos chats.
                if (historicoSaidasRepetidas.size > 2000) {
                    for (const [chave, tempos] of historicoSaidasRepetidas) {
                        if (!tempos.some(ts => agoraSaida - ts <= JANELA_CONTROLE_SPAM_MS)) historicoSaidasRepetidas.delete(chave);
                    }
                }
                if (historicoSaidasPorChat.size > 1000) {
                    for (const [chave, tempos] of historicoSaidasPorChat) {
                        if (!tempos.some(ts => agoraSaida - ts <= 10000)) historicoSaidasPorChat.delete(chave);
                    }
                }
            }

            let enviada;
            try {
                enviada = await sendMessageOriginal(...args);
            } catch (erroEnvio) {
                const detalhe = String(erroEnvio?.message || erroEnvio || 'erro desconhecido');
                console.error('[ENVIO] Falha ao enviar mensagem pelo WhatsApp:', detalhe);
                // Se a falha indicar transporte/socket, renova a conexão em vez de
                // deixar o bot continuar usando uma conexão que não envia respostas.
                if (sockAtual === sock && !socketsEncerrados.has(sock) && !trocaManualEmAndamento &&
                    /timeout|timed out|connection|socket|websocket|closed|stream errored|not open/i.test(detalhe)) {
                    agendarReconexao('falha de transporte durante envio');
                }
                throw erroEnvio;
            }
            const idEnviado = enviada?.key?.id;
            if (idEnviado) {
                marcarMensagemIgnorar(idEnviado, 2 * 60 * 1000);
            }
            return enviada;
        };

        function obterJidsDaContaBot() {
            const valores = [
                sock.user?.id,
                sock.user?.jid,
                sock.user?.lid,
                sock.user?.phoneNumber,
                sock.user?.phone_number,
                state.creds?.me?.id,
                state.creds?.me?.lid
            ];
            return [...new Set(valores.flatMap(extrairJidsDeValor).map(normalizarJidCompleto).filter(Boolean))];
        }

        // Retorna um endereço JID válido, sem acrescentar @s.whatsapp.net duas vezes
        // e sem converter uma identidade @lid em um falso JID de telefone.
        function getBotJid() {
            const jids = obterJidsDaContaBot();
            return jids.find(jid => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us'))
                || jids.find(jid => jid.endsWith('@lid'))
                || jids[0]
                || '';
        }

        async function participanteEhBot(participante) {
            const candidatos = [...new Set(extrairJidsDeValor(participante).map(normalizarJidCompleto).filter(Boolean))];
            if (!candidatos.length) return false;
            const jidsBot = obterJidsDaContaBot();
            if (candidatos.some(jid => jidsBot.includes(jid))) return true;

            const lidMapping = sock.signalRepository?.lidMapping;
            if (!lidMapping) return false;
            for (const candidato of candidatos) {
                try {
                    if (candidato.endsWith('@lid') && typeof lidMapping.getPNForLID === 'function') {
                        const pn = normalizarJidCompleto(await lidMapping.getPNForLID(candidato));
                        if (pn && jidsBot.includes(pn)) return true;
                    } else if ((candidato.endsWith('@s.whatsapp.net') || candidato.endsWith('@c.us')) &&
                               typeof lidMapping.getLIDForPN === 'function') {
                        const lid = normalizarJidCompleto(await lidMapping.getLIDForPN(candidato));
                        if (lid && jidsBot.includes(lid)) return true;
                    }
                } catch (_) {}
            }
            return false;
        }

        function limparAutorizacaoPendenteGrupo(remoteJid) {
            const pendencia = temporizadoresAutorizacaoGrupo.get(remoteJid);
            if (pendencia?.timer) clearTimeout(pendencia.timer);
            temporizadoresAutorizacaoGrupo.delete(remoteJid);
            const timerAvisoDono = temporizadoresRetryAvisoConfiguracaoDono.get(remoteJid);
            if (timerAvisoDono) clearTimeout(timerAvisoDono);
            temporizadoresRetryAvisoConfiguracaoDono.delete(remoteJid);
            tentativasAvisoConfiguracaoDono.delete(remoteJid);
            if (dadosGlobais.gruposAguardandoAutorizacao?.[remoteJid]) {
                delete dadosGlobais.gruposAguardandoAutorizacao[remoteJid];
            }
            for (const chave of ultimosAvisosBloqueioGrupo.keys()) {
                if (chave.startsWith(`${remoteJid}|`)) ultimosAvisosBloqueioGrupo.delete(chave);
            }
        }

        function agendarNovaTentativaSaidaGrupo(remoteJid, esperaMs = 15000) {
            const pedido = dadosGlobais.gruposAguardandoAutorizacao?.[remoteJid];
            if (!pedido) return;
            const atual = temporizadoresAutorizacaoGrupo.get(remoteJid);
            if (atual?.timer) clearTimeout(atual.timer);
            const timer = setTimeout(() => {
                temporizadoresAutorizacaoGrupo.delete(remoteJid);
                void tentarSairGrupoSemConfiguracao(remoteJid);
            }, Math.max(1000, esperaMs));
            timer.unref?.();
            temporizadoresAutorizacaoGrupo.set(remoteJid, { timer, iniciadoEm: pedido.criadoEm || Date.now(), retrySaida: true });
        }

        async function tentarSairGrupoSemConfiguracao(remoteJid) {
            if (expiracoesAutorizacaoEmAndamento.has(remoteJid)) return;
            const pedidoAtual = dadosGlobais.gruposAguardandoAutorizacao?.[remoteJid];
            if (!pedidoAtual) return;

            const statusAtual = String(dadosGlobais.statusAluguelGrupos?.[remoteJid] || '').toLowerCase();
            if (['pg', 'gc'].includes(statusAtual)) {
                limparAutorizacaoPendenteGrupo(remoteJid);
                await salvarDadosBot(dadosGlobais).catch(() => {});
                return;
            }

            expiracoesAutorizacaoEmAndamento.add(remoteJid);
            try {
                const socketOperacional = sockAtual;
                if (!socketOperacional || !socketAberto || socketsEncerrados.has(socketOperacional)) {
                    // Não apaga a pendência enquanto não houver conexão para sair.
                    // Ao reconectar, o open handler também verifica prazos já expirados.
                    agendarNovaTentativaSaidaGrupo(remoteJid, 15000);
                    return;
                }

                const motivoNpg = statusAtual === 'npg' || pedidoAtual.motivoSaida === 'npg';
                try {
                    await socketOperacional.sendMessage(remoteJid, {
                        text: motivoNpg
                            ? '🚫 *ArleyBot está bloqueado neste grupo (NPG).* O bot vai sair agora.'
                            : '🚫 *Grupo não configurado.* O prazo de 1 minuto terminou sem uma escolha do dono. O ArleyBot vai sair deste grupo agora.'
                    });
                } catch (erroAvisoFinal) {
                    console.warn('[AUTORIZAÇÃO] Não consegui enviar o aviso final ao grupo:', erroAvisoFinal?.message || erroAvisoFinal);
                }

                if (!motivoNpg) {
                    const numeroDonoAviso = String(dadosGlobais.numeroDono || '').replace(/\D/g, '');
                    if (numeroDonoAviso.length >= 10 && numeroDonoAviso.length <= 15) {
                        await socketOperacional.sendMessage(`${numeroDonoAviso}@s.whatsapp.net`, {
                            text: `⏰ O prazo de configuração terminou para o grupo ${pedidoAtual.nome || remoteJid}. Não foi escolhido PG, GC ou NPG; o ArleyBot está saindo do grupo.`
                        }).catch(erro => console.warn('[AUTORIZAÇÃO] Não consegui avisar o dono sobre a expiração:', erro?.message || erro));
                    }
                }

                // O dono pode ter escolhido PG/GC enquanto os avisos eram enviados.
                const statusAntesDeSair = String(dadosGlobais.statusAluguelGrupos?.[remoteJid] || '').toLowerCase();
                if (['pg', 'gc'].includes(statusAntesDeSair)) {
                    limparAutorizacaoPendenteGrupo(remoteJid);
                    await salvarDadosBot(dadosGlobais).catch(() => {});
                    return;
                }
                // Se o dono prorrogou o prazo enquanto os avisos estavam sendo enviados,
                // respeita o novo prazo e não executa uma saída prematura.
                if (!motivoNpg && dadosGlobais.gruposAguardandoAutorizacao?.[remoteJid] === pedidoAtual &&
                    Number(pedidoAtual.expiraEm) > Date.now()) {
                    return;
                }

                try {
                    await executarComTentativas(() => socketOperacional.groupLeave(remoteJid), 3, 1000);
                    // A pendência só é removida depois que o Baileys confirma a saída.
                    if (dadosGlobais.gruposAguardandoAutorizacao?.[remoteJid] === pedidoAtual) {
                        limparAutorizacaoPendenteGrupo(remoteJid);
                    }
                    await salvarDadosBot(dadosGlobais).catch(erro => console.warn('[AUTORIZAÇÃO] Saída concluída, mas não consegui salvar a limpeza da pendência:', erro?.message || erro));
                } catch (erroSaida) {
                    console.warn('[AUTORIZAÇÃO] Não consegui sair do grupo agora; a saída será tentada novamente:', erroSaida?.message || erroSaida);
                    if (dadosGlobais.gruposAguardandoAutorizacao?.[remoteJid] === pedidoAtual) {
                        pedidoAtual.expiraEm = Date.now();
                        pedidoAtual.saidaPendente = true;
                        await salvarDadosBot(dadosGlobais).catch(() => {});
                        agendarNovaTentativaSaidaGrupo(remoteJid, 15000);
                    }
                }
            } finally {
                expiracoesAutorizacaoEmAndamento.delete(remoteJid);
            }
        }

        function iniciarPrazoAutorizacaoGrupo(remoteJid) {
            if (!remoteJid?.endsWith('@g.us')) return;
            const pedido = dadosGlobais.gruposAguardandoAutorizacao?.[remoteJid];
            if (!pedido) return;
            const statusAtual = String(dadosGlobais.statusAluguelGrupos?.[remoteJid] || '').toLowerCase();
            if (['pg', 'gc'].includes(statusAtual)) {
                limparAutorizacaoPendenteGrupo(remoteJid);
                return;
            }
            if (temporizadoresAutorizacaoGrupo.has(remoteJid)) return;

            const prazoFinal = Number(pedido.expiraEm) || (Date.now() + PRAZO_AUTORIZACAO_GRUPO_MS);
            pedido.expiraEm = prazoFinal;
            const timer = setTimeout(() => {
                temporizadoresAutorizacaoGrupo.delete(remoteJid);
                void tentarSairGrupoSemConfiguracao(remoteJid);
            }, Math.max(0, prazoFinal - Date.now()));
            timer.unref?.();
            temporizadoresAutorizacaoGrupo.set(remoteJid, { timer, iniciadoEm: pedido.criadoEm || Date.now() });
        }

        async function avisarGrupoBloqueado(remoteJid, status, opcoes = {}) {
            // Nunca responde nem agenda saída para grupos históricos que não passaram pelo evento de entrada.
            if (!remoteJid?.endsWith('@g.us') || ['pg', 'gc'].includes(status) || !dadosGlobais.gruposAguardandoAutorizacao?.[remoteJid]) return;
            const origemAviso = opcoes.quoted ? 'comando' : 'entrada';
            const chaveAviso = `${remoteJid}|pendente|${origemAviso}`;
            const agora = Date.now();
            const ultimoAviso = ultimosAvisosBloqueioGrupo.get(chaveAviso) || 0;
            if (!opcoes.force && agora - ultimoAviso < INTERVALO_AVISO_BLOQUEIO_GRUPO_MS) return;
            ultimosAvisosBloqueioGrupo.set(chaveAviso, agora);
            while (ultimosAvisosBloqueioGrupo.size > 2000) {
                ultimosAvisosBloqueioGrupo.delete(ultimosAvisosBloqueioGrupo.keys().next().value);
            }
            const textoAviso = '⚠️ *ArleyBot ainda não está configurado neste grupo.* O dono será avisado em privado. Se não escolher PG, GC ou NPG em até 1 minuto, o bot sairá automaticamente.';
            try {
                await (sockAtual || sock).sendMessage(remoteJid, { text: textoAviso }, opcoes.quoted ? { quoted: opcoes.quoted } : {});
            } catch (erroAvisoBloqueio) {
                console.warn('[AUTORIZAÇÃO] Não consegui enviar o aviso de grupo bloqueado:', erroAvisoBloqueio?.message || erroAvisoBloqueio);
            }
        }

        async function enviarSolicitacaoConfiguracaoAoDono(remoteJid) {
            const pedido = dadosGlobais.gruposAguardandoAutorizacao?.[remoteJid];
            const statusAtual = String(dadosGlobais.statusAluguelGrupos?.[remoteJid] || '').toLowerCase();
            if (!pedido || pedido.avisoDonoEnviado || solicitacoesConfiguracaoEmAndamento.has(remoteJid) || ['pg', 'gc', 'npg'].includes(statusAtual)) return;

            const timerRetryAnterior = temporizadoresRetryAvisoConfiguracaoDono.get(remoteJid);
            if (timerRetryAnterior) {
                clearTimeout(timerRetryAnterior);
                temporizadoresRetryAvisoConfiguracaoDono.delete(remoteJid);
            }
            solicitacoesConfiguracaoEmAndamento.add(remoteJid);
            let mensagemEnviada = false;
            try {
                const numeroDonoDM = String(dadosGlobais.numeroDono || '').replace(/\D/g, '');
                if (!/^\d{10,15}$/.test(numeroDonoDM)) {
                    console.error('[AUTORIZAÇÃO] numeroDono ausente ou inválido em dados.json; não consigo enviar a solicitação privada.');
                    return;
                }
                let nomeGrupoDM = remoteJid;
                try {
                    nomeGrupoDM = String((await obterMetadadosGrupoComTimeout(remoteJid, 5000))?.subject || remoteJid)
                        .replace(/[\r\n]/g, ' ').slice(0, 100);
                } catch (_) {}
                // O pedido pode ter sido resolvido enquanto aguardávamos os metadados.
                // Não envie um painel antigo nem use um socket que já foi substituído.
                const pedidoAindaPendente = dadosGlobais.gruposAguardandoAutorizacao?.[remoteJid];
                const statusAntesDoEnvio = String(dadosGlobais.statusAluguelGrupos?.[remoteJid] || '').toLowerCase();
                if (pedidoAindaPendente !== pedido || ['pg', 'gc', 'npg'].includes(statusAntesDoEnvio) ||
                    sockAtual !== sock || !socketAberto || socketsEncerrados.has(sock)) return;
                pedido.nome = nomeGrupoDM;
                const donoJidDM = `${numeroDonoDM}@s.whatsapp.net`;
                const resultadoEnvio = await enviarBotoesWhatsApp(donoJidDM,
                    `➕ *O ArleyBot foi adicionado a um grupo novo!*

🏷️ *Grupo:* ${nomeGrupoDM}
🆔 *ID:* ${remoteJid}

Escolha como configurar o grupo. Se selecionar *Não configurar*, o ArleyBot aguardará 1 minuto a partir da sua escolha e depois sairá automaticamente. Se não responder, o prazo original de 1 minuto também continua valendo.`,
                    [
                        { id: `ARLEY_GRUPO|pg|${remoteJid}`, text: '💵 PG — Pago' },
                        { id: `ARLEY_GRUPO|gc|${remoteJid}`, text: '🆓 GC — Gratuito' },
                        { id: `ARLEY_GRUPO|npg|${remoteJid}`, text: '🚫 NPG — Sair' },
                        { id: `ARLEY_GRUPO|aguardar|${remoteJid}`, text: '⏳ Não configurar (sair em 1 min)' }
                    ], { maxButtons: 4 });
                if (!resultadoEnvio) throw new Error('O envio da mensagem privada não retornou confirmação.');
                mensagemEnviada = true;
                pedido.avisoDonoEnviado = true;
                tentativasAvisoConfiguracaoDono.delete(remoteJid);
                // Se a gravação falhar, não envia duplicatas durante este processo; o estado
                // em disco será reavaliado na próxima inicialização.
                await salvarDadosBot(dadosGlobais).catch(erro => {
                    console.warn('[AUTORIZAÇÃO] A solicitação foi enviada, mas não consegui salvar a confirmação:', erro?.message || erro);
                });
            } catch (erroDM) {
                if (!mensagemEnviada) {
                    pedido.avisoDonoEnviado = false;
                    const tentativa = (tentativasAvisoConfiguracaoDono.get(remoteJid) || 0) + 1;
                    tentativasAvisoConfiguracaoDono.set(remoteJid, tentativa);
                    console.warn('[AUTORIZAÇÃO] Não consegui enviar a solicitação privada ao dono:', erroDM?.message || erroDM);
                    // Repete poucas vezes apenas se este socket ainda for o atual e estiver aberto.
                    // Se ele cair, o próximo evento open reenvia a solicitação pendente.
                    if (tentativa <= 3 && sockAtual === sock && socketAberto) {
                        const espera = Math.min(20000, 5000 * tentativa);
                        const timerRetry = setTimeout(() => {
                            temporizadoresRetryAvisoConfiguracaoDono.delete(remoteJid);
                            if (sockAtual === sock && socketAberto) void enviarSolicitacaoConfiguracaoAoDono(remoteJid);
                        }, espera);
                        timerRetry.unref?.();
                        temporizadoresRetryAvisoConfiguracaoDono.set(remoteJid, timerRetry);
                    }
                } else {
                    console.warn('[AUTORIZAÇÃO] A notificação chegou a ser enviada, mas houve uma falha secundária:', erroDM?.message || erroDM);
                }
            } finally {
                solicitacoesConfiguracaoEmAndamento.delete(remoteJid);
            }
        }

        // Retoma somente solicitações realmente criadas quando o bot foi adicionado.
        for (const [jidPendente, pedidoPendente] of Object.entries(dadosGlobais.gruposAguardandoAutorizacao || {})) {
            if (!jidPendente.endsWith('@g.us') || !pedidoPendente || typeof pedidoPendente !== 'object') {
                delete dadosGlobais.gruposAguardandoAutorizacao[jidPendente];
                continue;
            }
            iniciarPrazoAutorizacaoGrupo(jidPendente);
            if (!pedidoPendente.avisoDonoEnviado && (Number(pedidoPendente.expiraEm) || 0) > Date.now()) {
                void enviarSolicitacaoConfiguracaoAoDono(jidPendente);
            }
        }

        // Consultas de metadados não podem prender os comandos por até 45 segundos.
        // Se o WhatsApp estiver lento, a chamada falha rapidamente e o comando segue
        // pelo tratamento de erro/fallback já existente.
        async function obterMetadadosGrupoComTimeout(remoteJid, timeoutMs = 8000) {
            let temporizador = null;
            try {
                return await Promise.race([
                    sock.groupMetadata(remoteJid),
                    new Promise((_, reject) => {
                        temporizador = setTimeout(() => reject(new Error(`Consulta de metadados excedeu ${timeoutMs} ms`)), timeoutMs);
                        temporizador.unref?.();
                    })
                ]);
            } finally {
                if (temporizador) clearTimeout(temporizador);
            }
        }


        // Nome dos grupos para os logs do Termux. A consulta é assíncrona para
        // não atrasar a execução dos comandos; nomes ficam em cache por 30 minutos.
        const cacheNomeGrupoTerminal = new Map();
        const consultasNomeGrupoTerminal = new Map();
        const TTL_NOME_GRUPO_TERMINAL_MS = 30 * 60 * 1000;

        function limparTextoTerminal(valor, limite = 80) {
            return String(valor || '')
                .replace(/[\x00-\x1F\x7F-\x9F]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, limite);
        }

        async function obterNomeGrupoParaLog(remoteJid) {
            if (!remoteJid?.endsWith('@g.us')) return null;
            const agora = Date.now();
            const cacheado = cacheNomeGrupoTerminal.get(remoteJid);
            if (cacheado && cacheado.expiraEm > agora) return cacheado.nome;
            if (consultasNomeGrupoTerminal.has(remoteJid)) return consultasNomeGrupoTerminal.get(remoteJid);

            const consulta = (async () => {
                try {
                    const metadata = await obterMetadadosGrupoComTimeout(remoteJid, 2500);
                    const nome = limparTextoTerminal(metadata?.subject, 80);
                    cacheNomeGrupoTerminal.set(remoteJid, {
                        nome: nome || null,
                        expiraEm: Date.now() + (nome ? TTL_NOME_GRUPO_TERMINAL_MS : 15000)
                    });
                    return nome || null;
                } catch (_) {
                    // Cache curto para não repetir consultas em sequência quando o WhatsApp falhar.
                    cacheNomeGrupoTerminal.set(remoteJid, { nome: null, expiraEm: Date.now() + 15000 });
                    return null;
                } finally {
                    consultasNomeGrupoTerminal.delete(remoteJid);
                }
            })();
            consultasNomeGrupoTerminal.set(remoteJid, consulta);
            return consulta;
        }

        const ROTULOS_STATUS_ALUGUEL_TERMINAL = {
            pg: '[Pago]',
            npg: '[Não Pago]',
            gc: '[Grátis]'
        };

        function registrarLogComandoTerminal({ m, cleanSender, remoteJid, prefix, command, statusLabel = '' }) {
            const nomeTerminalComando = limparTextoTerminal(m?.pushName || cleanSender, 40) || 'usuário';
            const idGrupo = remoteJid?.endsWith('@g.us') ? remoteJid.split('@')[0] : '';
            const ehPrivado = !idGrupo;
            const statusAtualGrupo = ehPrivado ? '' : (dadosGlobais.statusAluguelGrupos?.[remoteJid] || '');
            const rotuloStatus = ehPrivado
                ? ''
                : (statusLabel || ROTULOS_STATUS_ALUGUEL_TERMINAL[statusAtualGrupo] || '[Não Cadastrado]');
            const colorir = !process.env.NO_COLOR;
            const resetCor = colorir ? '\x1b[0m' : '';
            const cor = !colorir ? '' : ehPrivado
                ? '\x1b[38;5;255m'
                : statusAtualGrupo === 'pg' ? '\x1b[38;5;75m'
                    : statusAtualGrupo === 'gc' ? '\x1b[38;5;78m'
                        : statusAtualGrupo === 'npg' ? '\x1b[38;5;160m'
                            : '\x1b[38;5;245m';
            const finalizarLog = (nomeGrupo = null) => {
                const parteGrupo = idGrupo
                    ? `grupo ${nomeGrupo || idGrupo} (${idGrupo})`
                    : 'privado';
                const parteStatus = rotuloStatus ? ` ${rotuloStatus}` : '';
                console.log(`${cor}📩 [COMANDO] ${nomeTerminalComando} (${cleanSender}) | ${parteGrupo}${parteStatus} | ${prefix}${command}${resetCor}`);
            };

            if (idGrupo) {
                void obterNomeGrupoParaLog(remoteJid).then(finalizarLog).catch(() => finalizarLog());
            } else {
                finalizarLog();
            }
        }
        function resetarInatividade(remoteJid) {
            if (temporizadoresInatividade[remoteJid]) {
                clearTimeout(temporizadoresInatividade[remoteJid]);
                delete temporizadoresInatividade[remoteJid];
            }

            if (!['pg', 'gc'].includes(dadosGlobais.statusAluguelGrupos?.[remoteJid])) return;

            const brincadeirasAtivas = !!dadosGlobais.brincadeiras?.[remoteJid];
            // Compatibilidade: grupos antigos continuam com o recurso ativo
            // até o administrador usar o comando de desativação.
            const mensagensAleatoriasAtivas =
                dadosGlobais.mensagensAleatorias?.[remoteJid] !== false;

            if (brincadeirasAtivas && mensagensAleatoriasAtivas) {
                const tempoMs = (Math.floor(Math.random() * 2) + 2) * 60 * 1000;

                temporizadoresInatividade[remoteJid] = setTimeout(async () => {
                    delete temporizadoresInatividade[remoteJid];

                    if (!dadosGlobais.brincadeiras?.[remoteJid] ||
                        dadosGlobais.mensagensAleatorias?.[remoteJid] === false ||
                        !['pg', 'gc'].includes(dadosGlobais.statusAluguelGrupos?.[remoteJid])) {
                        return;
                    }

                    const frases = [
                        "Bora pessoal mandar msg! 🥱 O grupo tá mais parado que água de poço!",
                        "Eita silêncio... Tem alguém vivo aí? 👀",
                        "Cri cri cri... 🦗 Cadê a animação desse grupo?",
                        "Gente, bora conversar! Daqui a pouco nasce teia de aranha aqui. 🕸️",
                        "Tô me sentindo solitário... Alguém manda um 'oi' pelo menos! 🥺"
                    ];

                    const frase = frases[Math.floor(Math.random() * frases.length)];

                    try {
                        await sock.sendMessage(remoteJid, { text: frase });
                    } catch (e) {}
                }, tempoMs);
            }
        }

        function mensagemAleatoriaProcessamento(tipo) {
            const mensagens = {
                audio: [
                    '⏳ Aguenta só um pouquinho, tô buscando esse som! 🎧',
                    '🎵 O DJ ArleyBot já está preparando essa pedrada kkkkk.',
                    '🔊 Segura a ansiedade que esse áudio já vem!',
                    '😂 Até o DJ precisa de uns segundos pra fazer a mágica!',
                    '📥 Preparando o áudio. Não fecha o WhatsApp ainda!'
                ],
                sticker: [
                    '😂 Eita, essa figurinha vai ser histórica, espera aí que já já tô enviando kkkk',
                    '🤣 Essa vai virar figurinha de milhões. Só mais um instante!',
                    '🎨 ArleyBot tá na oficina: não sai daí que vem obra-prima!',
                    '😎 Calma, artista trabalhando! Já já essa figurinha chega.',
                    '🪄 Se prepara pro resultado... a magia tá acontecendo kkkkk.'
                ],
                imagem: [
                    '🖼️ Tô tirando essa imagem do forno, só um instante!',
                    '👀 Segura aí que a imagem já tá quase pronta kkkkk.',
                    '✨ Organizando os pixels pra ficar tudo certinho!',
                    '📸 Calma que já vou revelar essa imagem pra você.'
                ],
                conversao: [
                    '😂 Eita, essa conversão tá trabalhando mais que eu na segunda-feira kkkk.',
                    '🛠️ Tô ajustando tudo aqui. Daqui a pouco sai!',
                    '⚡ Mais alguns segundos e a mágica acontece!',
                    '🤖 O robozinho tá fazendo hora extra pra você kkkkk.'
                ],
                aviso: [
                    '📢 Recebendo o aviso e organizando as próximas etapas...',
                    '⏳ Só conferindo o texto e os grupos que vão receber o aviso.',
                    '📝 Aviso chegando; vou salvar e preparar a confirmação.',
                    '📬 Recebendo avisos... só mais um instante.'
                ],
                video: [
                    '⏳ Recebi! Tô preparando esse vídeo, aguenta aí.',
                    '📥 Baixando e organizando o vídeo... já já chega!',
                    '😂 Calma, diretor! O vídeo tá sendo preparado kkkkk.',
                    '🎬 Deixa comigo, tô cuidando dos últimos detalhes.',
                    '🚀 Esse vídeo já tá a caminho!'
                ]
            };
            const lista = mensagens[tipo] || mensagens.video;
            return lista[Math.floor(Math.random() * lista.length)];
        }

        // Mantém uma única mensagem de progresso. IMPORTANTE: a chave de edição
        // é imutável; o retorno de uma edição pode ter outra chave e nunca deve
        // substituir a chave da mensagem original, senão as próximas atualizações
        // viram mensagens novas (spam) em algumas versões do Baileys.
        async function criarBarraProgressoWhatsApp(remoteJid, m, titulo, tipoMensagem = 'sticker') {
            let fraseAtual = mensagemAleatoriaProcessamento(tipoMensagem);
            const mensagemProgresso = await sock.sendMessage(remoteJid, {
                text: `⏳ *${titulo}*\n[░░░░░░░░░░░░░░░░░░░░] 0%\n_Iniciando..._\n\n${fraseAtual}`
            }, { quoted: m });
            const chaveMensagemOriginal = mensagemProgresso?.key;
            let ultimoPercentual = 0;
            let ultimaEtapa = 'Iniciando...';
            let ultimaAtualizacao = 0;
            let ultimaTrocaFrase = Date.now();
            let edicaoIndisponivel = false;
            let filaEdicao = Promise.resolve();

            function textoProgresso(percentual, etapa) {
                const valor = Math.max(0, Math.min(100, Math.floor(percentual)));
                const largura = 20;
                const preenchidos = Math.round((valor / 100) * largura);
                const barra = '█'.repeat(preenchidos) + '░'.repeat(largura - preenchidos);
                return `⏳ *${titulo}*\n[${barra}] ${valor}%\n_${etapa}_\n\n${fraseAtual}`;
            }

            async function atualizar(percentual, etapa = 'Processando...', forcar = false) {
                const valorSolicitado = Math.max(0, Math.min(100, Number(percentual) || 0));
                const valor = Math.max(ultimoPercentual, valorSolicitado);
                const etapaAtual = String(etapa || 'Processando...');
                const agora = Date.now();
                let trocouFrase = false;

                // Troca a frase engraçada no máximo a cada 7 segundos, dentro da
                // mesma mensagem, sem criar novas mensagens no grupo.
                if (agora - ultimaTrocaFrase >= 7000) {
                    const fraseAnterior = fraseAtual;
                    for (let i = 0; i < 4 && fraseAtual === fraseAnterior; i++) {
                        fraseAtual = mensagemAleatoriaProcessamento(tipoMensagem);
                    }
                    ultimaTrocaFrase = agora;
                    trocouFrase = fraseAtual !== fraseAnterior;
                }

                if (!forcar && valor === ultimoPercentual && etapaAtual === ultimaEtapa && !trocouFrase) {
                    return filaEdicao;
                }
                // Limita a frequência das edições para evitar rajadas de atualização.
                if (!forcar && agora - ultimaAtualizacao < 1100 &&
                    valor - ultimoPercentual < 3 && etapaAtual === ultimaEtapa && !trocouFrase) {
                    return filaEdicao;
                }

                ultimoPercentual = valor;
                ultimaEtapa = etapaAtual;
                ultimaAtualizacao = agora;
                const conteudo = textoProgresso(valor, etapaAtual);

                filaEdicao = filaEdicao.catch(() => {}).then(async () => {
                    if (edicaoIndisponivel || !chaveMensagemOriginal) return;
                    try {
                        // Sempre edita a mensagem original; não substitua essa chave
                        // pelo key retornado pelo pedido de edição.
                        await sock.sendMessage(remoteJid, {
                            text: conteudo,
                            edit: chaveMensagemOriginal
                        });
                    } catch (erroEdicao) {
                        // Nunca envie uma nova mensagem de fallback em cada atualização.
                        // Desativa as próximas tentativas para impedir spam e registra uma vez.
                        edicaoIndisponivel = true;
                        console.warn('⚠️ A edição da barra de progresso falhou; novas mensagens foram bloqueadas para evitar spam:', erroEdicao?.message || erroEdicao);
                    }
                });
                return filaEdicao;
            }

            return {
                atualizar,
                finalizar: async (etapa = 'Concluído!') => atualizar(100, `✅ ${etapa}`, true),
                falhar: async (etapa = 'Não foi possível concluir.') => atualizar(ultimoPercentual, `❌ ${etapa}`, true),
                // Para respostas de texto, aproveita a mensagem de carregamento como resposta final.
                substituir: async (conteudoFinal) => {
                    await filaEdicao.catch(() => {});
                    if (edicaoIndisponivel || !chaveMensagemOriginal || !conteudoFinal || typeof conteudoFinal !== 'object') return null;
                    try {
                        const conteudoEdicao = { ...conteudoFinal, edit: chaveMensagemOriginal };
                        return await sock.sendMessage(remoteJid, conteudoEdicao);
                    } catch (erroSubstituicao) {
                        edicaoIndisponivel = true;
                        console.warn('[CARREGAMENTO] Não consegui substituir a mensagem de progresso pelo resultado:', erroSubstituicao?.message || erroSubstituicao);
                        return null;
                    }
                },
                percentual: () => ultimoPercentual
            };
        }

        async function iniciarCarregamentoComando(remoteJid, m, titulo, etapa = 'Preparando...') {
            try {
                const barra = await criarBarraProgressoWhatsApp(remoteJid, m, titulo, 'conversao');
                await barra.atualizar(15, etapa, true);
                return barra;
            } catch (_) {
                // O indicador é cosmético: sua falha não deve impedir o comando.
                return null;
            }
        }

        // O yt-dlp costuma escrever porcentagem real em stderr; --newline faz
        // cada atualização terminar em uma linha e permite interpretar o percentual.
        function criarCallbacksProgressoYtDlp(barra, inicio = 12, fim = 88) {
            let restante = '';
            const processar = (trecho) => {
                restante += String(trecho || '');
                const linhas = restante.split(/\r\n|\n|\r/);
                restante = linhas.pop() || '';
                for (const linha of linhas) {
                    const corresponde = linha.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
                    if (!corresponde) continue;
                    const percentualDownload = Math.max(0, Math.min(100, Number(corresponde[1]) || 0));
                    const percentualGeral = inicio + ((fim - inicio) * percentualDownload / 100);
                    void barra.atualizar(percentualGeral, `Baixando: ${percentualDownload.toFixed(1)}%`);
                }
            };
            return { onStdout: processar, onStderr: processar };
        }

        async function enviarEIgnorar(remoteJid, content, options = {}) {
            const sent = await sock.sendMessage(remoteJid, content, options);
            if (sent?.key?.id) {
                marcarMensagemIgnorar(sent.key.id, 60000);
            }
            return sent;
        }

        // Envia botões nativos com os nós binários necessários para o WhatsApp.
        // A miniatura (quando existir) é preparada no cabeçalho da mesma mensagem,
        // para não deixar uma imagem isolada caso a mensagem interativa seja ignorada.
        async function enviarBotoesWhatsApp(remoteJid, texto, botoes, options = {}, midia = null) {
            // 3 opções é o padrão seguro; o tabuleiro da velha solicita explicitamente 9.
            const limiteBotoes = Math.max(1, Math.min(9, Number(options?.maxButtons) || 3));
            const opcoesEnvio = { ...(options || {}) };
            delete opcoesEnvio.maxButtons;
            const lista = (Array.isArray(botoes) ? botoes : []).slice(0, limiteBotoes).map((b) => ({
                id: String(b?.id ?? ''),
                text: String(b?.text || b?.id || 'Escolher opção').slice(0, 20)
            })).filter((b) => b.id);
            const textoBase = String(texto || 'Escolha uma opção:');
            const listaFallback = lista.map((b, i) => `${i + 1}. ${b.text} → ${b.id}`).join('\n');
            const fallback = `${textoBase}\n\n${listaFallback}\n\nSe os botões não aparecerem, responda com o código da opção.`;
            const mentions = Array.isArray(options?.mentions) ? options.mentions.filter(Boolean) : [];

            if (!lista.length) {
                return await enviarEIgnorar(remoteJid, { text: fallback, mentions }, opcoesEnvio);
            }

            let mediaHeader = {};
            if (midia?.image) {
                try {
                    // O upload da miniatura faz parte do cabeçalho da mensagem interativa.
                    const preparada = await prepareWAMessageMedia(
                        { image: midia.image },
                        { upload: sock.waUploadToServer }
                    );
                    if (preparada?.imageMessage) mediaHeader = preparada;
                } catch (erroMiniatura) {
                    console.warn('[BOTÕES] Não consegui preparar a miniatura; enviarei texto e botões:', erroMiniatura?.message || erroMiniatura);
                }
            }

            const nativeButtons = lista.map((b) => ({
                name: 'quick_reply',
                buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.id })
            }));

            try {
                const mensagemInterativa = proto.Message.InteractiveMessage.create({
                    body: proto.Message.InteractiveMessage.Body.create({ text: textoBase }),
                    footer: proto.Message.InteractiveMessage.Footer.create({ text: 'ArleyBot' }),
                    header: proto.Message.InteractiveMessage.Header.create({
                        title: mediaHeader.imageMessage ? '🎬 Prévia do vídeo' : 'Escolha uma opção',
                        hasMediaAttachment: Boolean(mediaHeader.imageMessage),
                        ...mediaHeader
                    }),
                    ...(mentions.length ? { contextInfo: { mentionedJid: mentions } } : {}),
                    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                        buttons: nativeButtons,
                        messageParamsJson: ''
                    })
                });

                const mensagemGerada = generateWAMessageFromContent(remoteJid, {
                    messageContextInfo: {
                        deviceListMetadata: {},
                        deviceListMetadataVersion: 2
                    },
                    interactiveMessage: mensagemInterativa
                }, {
                    userJid: sock.user?.id,
                    quoted: options?.quoted
                });

                // Compatibilidade com clientes multi-dispositivo, conforme a técnica
                // usada pelas bibliotecas auxiliares atuais de botões para Baileys.
                mensagemGerada.message = {
                    documentWithCaptionMessage: {
                        message: { ...mensagemGerada.message }
                    }
                };

                // WhiskeySockets/Baileys não injeta estes nós automaticamente neste
                // caminho de relay; sem eles o WhatsApp pode omitir os botões sem erro.
                const additionalNodes = [{
                    tag: 'biz',
                    attrs: {},
                    content: [{
                        tag: 'interactive',
                        attrs: { type: 'native_flow', v: '1' },
                        content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
                    }]
                }];
                await sock.relayMessage(remoteJid, mensagemGerada.message, {
                    messageId: mensagemGerada.key.id,
                    additionalNodes
                });
                marcarMensagemIgnorar(mensagemGerada.key.id, 60000);
                return mensagemGerada;
            } catch (erroBotoes) {
                console.error('[BOTÕES] O envio interativo falhou; tentando alternativa compatível:', erroBotoes?.message || erroBotoes);

                // Para uma grade com mais de 3 opções, tenta a lista nativa do WhatsApp:
                // ela suporta 9 casas sem forçar o participante a digitar comandos.
                if (lista.length > 3) {
                    try {
                        const enviadaLista = await sock.sendMessage(remoteJid, {
                            text: textoBase,
                            footer: 'ArleyBot',
                            buttonText: 'Escolher uma casa',
                            sections: [{
                                title: 'Casas disponíveis',
                                rows: lista.map((b) => ({ title: b.text, rowId: b.id, description: 'Selecionar esta casa' }))
                            }]
                        }, opcoesEnvio);
                        if (enviadaLista?.key?.id) marcarMensagemIgnorar(enviadaLista.key.id, 60000);
                        return enviadaLista;
                    } catch (erroLista) {
                        console.warn('[BOTÕES] Lista de opções indisponível; usando fallback em texto:', erroLista?.message || erroLista);
                        return await enviarEIgnorar(remoteJid, { text: fallback, mentions }, opcoesEnvio);
                    }
                }

                // Segunda tentativa: formato de botões tradicional do Baileys.
                // A informação da mídia continua na mesma mensagem.
                try {
                    const botoesLegados = lista.map((b) => ({
                        buttonId: b.id,
                        buttonText: { displayText: b.text },
                        type: 1
                    }));
                    const contentLegado = mediaHeader.imageMessage && midia?.image
                        ? { image: midia.image, caption: textoBase, footer: 'ArleyBot', buttons: botoesLegados }
                        : { text: textoBase, footer: 'ArleyBot', buttons: botoesLegados };
                    const enviada = await sock.sendMessage(remoteJid, contentLegado, opcoesEnvio);
                    if (enviada?.key?.id) marcarMensagemIgnorar(enviada.key.id, 60000);
                    return enviada;
                } catch (erroLegado) {
                    console.error('[BOTÕES] Alternativa tradicional também falhou:', erroLegado?.message || erroLegado);
                    return await enviarEIgnorar(remoteJid, { text: fallback, mentions }, opcoesEnvio);
                }
            }
        }

        async function enviarOpcoesAvisoTexto(remoteJid, texto, opcoes, options = {}) {
            // Os IDs são palavras simples (enviar/alterar/cancelar), tratadas pelo
            // fluxo de aviso antes do parser de comandos normais.
            const lista = (Array.isArray(opcoes) ? opcoes : []).slice(0, 3).map(opcao => ({
                id: String(opcao?.id || '').trim(),
                text: String(opcao?.text || opcao?.id || 'Opção')
            })).filter(opcao => opcao.id);
            const mensagem = `${String(texto || 'Escolha uma opção:')}\n\n_Para sair a qualquer momento, escolha Cancelar._`;
            return await enviarBotoesWhatsApp(remoteJid, mensagem, lista, options);
        }

        async function enviarPainelTabuleiroVelha(remoteJid, jogo, prefix, linhaTurno, options = {}) {
            // O WhatsApp tem limite prático de 3 botões de resposta por mensagem.
            // Enviamos o tabuleiro + três fileiras de 3 botões (1–3, 4–6 e 7–9).
            // O token muda a cada atualização para recusar cliques em tabuleiros antigos.
            jogo.tokenAtual = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
            const botoesCasas = Array.from({ length: 9 }, (_, i) => ({
                id: `${prefix}jogar ${i + 1} ${jogo.tokenAtual}`,
                text: `${i + 1} ${jogo.tabuleiro[i] === 'X' ? '❌' : jogo.tabuleiro[i] === 'O' ? '⭕' : '▫️'}`
            }));
            const mentions = [jogo.jogadorX, jogo.jogadorO].filter(j => j && j !== 'BOT');
            const textoTabuleiro = `🎮 *JOGO DA VELHA*\n\n${renderizarTabuleiroVelha(jogo.tabuleiro)}\n\n${linhaTurno}\n\nToque em uma das casas numeradas nos botões abaixo. A partida expira após 10 minutos sem atividade.`;
            const opcoesPrimeiraLinha = { ...options, mentions };
            const primeira = await enviarBotoesWhatsApp(remoteJid, textoTabuleiro, botoesCasas.slice(0, 3), opcoesPrimeiraLinha);
            // Atrasos pequenos evitam rajada de envios no celular, sem criar timers persistentes.
            await delay(100);
            await enviarBotoesWhatsApp(remoteJid, '🎮 *Mais casas — 4 a 6*', botoesCasas.slice(3, 6), { mentions });
            await delay(100);
            await enviarBotoesWhatsApp(remoteJid, '🎮 *Mais casas — 7 a 9*', botoesCasas.slice(6, 9), { mentions });
            return primeira;
        }

        async function enviarImagemMidiaSeExistir(remoteJid, nomeArquivo, options = {}) {
            const caminhoImagem = path.join(PASTA_MIDIA, nomeArquivo);
            // Legenda e menções pertencem ao conteúdo da mídia; quoted fica nas opções de envio.
            const { caption, mentions, ...opcoesEnvio } = options;
            try {
                if (!existsSync(caminhoImagem)) return false;
                const estatistica = await (await import('fs/promises')).stat(caminhoImagem);
                if (!estatistica.isFile() || estatistica.size <= 0 || estatistica.size > 8 * 1024 * 1024) return false;
                // Mantém margem segura abaixo do limite de legenda de mídia do WhatsApp.
                if (typeof caption === 'string' && caption.length > 950) return false;
                const bufferImagem = await readFile(caminhoImagem);
                if (!bufferImagem.length) return false;
                const mentionsUnicas = [...new Map(
                    (Array.isArray(mentions) ? mentions : [])
                        .filter(Boolean)
                        .map(jid => [normalizarJid(jid), jid])
                        .filter(([chave]) => Boolean(chave))
                ).values()];
                const conteudoImagem = {
                    image: bufferImagem,
                    mimetype: 'image/jpeg',
                    ...(typeof caption === 'string' && caption.length ? { caption } : {}),
                    ...(mentionsUnicas.length ? { mentions: mentionsUnicas } : {})
                };
                await enviarEIgnorar(remoteJid, conteudoImagem, opcoesEnvio);
                return true;
            } catch (erroImagem) {
                console.warn(`[MÍDIA] Não consegui enviar ${nomeArquivo}:`, erroImagem?.message || erroImagem);
                return false;
            }
        }

        // Envia JPEG com texto e marcações na legenda da própria imagem.
        // Se houver muita gente para marcar, divide as marcações entre cópias da imagem;
        // nunca manda o texto/menções soltos depois da mídia.
        async function enviarImagemComTodosNaLegenda({ sock, remoteJid, nomeArquivo, legendaBase, legendaSufixo = '', autorJid, participantesJid, quoted }) {
            const caminhoImagem = path.join(PASTA_MIDIA, nomeArquivo);
            if (!existsSync(caminhoImagem)) return false;
            const estatistica = await (await import('fs/promises')).stat(caminhoImagem);
            if (!estatistica.isFile() || estatistica.size <= 0 || estatistica.size > 8 * 1024 * 1024) return false;
            const bufferImagem = await readFile(caminhoImagem);
            if (!bufferImagem.length) return false;

            const autor = String(autorJid || '');
            const autorNormalizado = normalizarJid(autor);
            const unicos = [];
            const vistos = new Set();
            for (const jid of participantesJid || []) {
                if (!jid) continue;
                const chave = normalizarJid(jid);
                if (!chave || vistos.has(chave)) continue;
                vistos.add(chave);
                unicos.push(jid);
            }
            const demais = unicos.filter(jid => normalizarJid(jid) !== autorNormalizado);
            const LIMITE_LEGENDA = 900;
            const base = String(legendaBase || '').trim();
            const sufixo = String(legendaSufixo || '').trim();
            if (base.length + sufixo.length > LIMITE_LEGENDA - 80) throw new Error('O texto base é longo demais para uma legenda de imagem.');
            const partes = [];
            let atual = [];
            let tamanhoAtual = base.length + sufixo.length + 4;
            for (const jid of demais) {
                const token = `@${normalizarJid(jid)}`;
                const acrescimo = token.length + (atual.length ? 1 : 0);
                if (atual.length && tamanhoAtual + acrescimo > LIMITE_LEGENDA - 40) {
                    partes.push(atual);
                    atual = [];
                    tamanhoAtual = base.length + sufixo.length + 4;
                }
                atual.push(jid);
                tamanhoAtual += token.length + (atual.length > 1 ? 1 : 0);
            }
            if (atual.length || !partes.length) partes.push(atual);

            for (let i = 0; i < partes.length; i++) {
                const tokens = partes[i].map(jid => `@${normalizarJid(jid)}`).join(' ');
                const rotulo = partes.length > 1 ? `\n\n📣 Marcações ${i + 1}/${partes.length}` : '';
                const caption = `${base}${rotulo}${tokens ? `\n\n${tokens}` : ''}${sufixo ? `\n\n${sufixo}` : ''}`;
                const mentions = [...new Map([autor, ...partes[i]].filter(Boolean).map(jid => [normalizarJid(jid), jid])).values()];
                await enviarEIgnorar(remoteJid, {
                    image: bufferImagem,
                    mimetype: 'image/jpeg',
                    caption,
                    ...(mentions.length ? { mentions } : {})
                }, { quoted });
            }
            return true;
        }

        function limparTimeoutLog(sender, remoteJid) {
            const chave = remoteJid ? chaveEstadoChat(sender, remoteJid) : sender;
            if (temporizadoresLog[chave]) {
                clearTimeout(temporizadoresLog[chave]);
                delete temporizadoresLog[chave];
            }
        }

        function definirTimeoutLog(sender, remoteJid) {
            const chave = chaveEstadoChat(sender, remoteJid);
            limparTimeoutLog(sender, remoteJid);
            temporizadoresLog[chave] = setTimeout(async () => {
                if (aguardandoAcaoLog[chave]) {
                    delete aguardandoAcaoLog[chave];
                    delete temporizadoresLog[chave];
                    try {
                        await sock.sendMessage(remoteJid, { text: '⏱ *Tempo esgotado!* A alteração do log foi cancelada por inatividade (30 segundos).' });
                    } catch (err) {}
                }
            }, 30000);
        }

        function limparTimeoutTestar(sender, remoteJid) {
            const chave = remoteJid ? chaveEstadoChat(sender, remoteJid) : sender;
            if (temporizadoresTestar[chave]) {
                clearTimeout(temporizadoresTestar[chave]);
                delete temporizadoresTestar[chave];
            }
        }

        function definirTimeoutTestar(sender, remoteJid) {
            const chave = chaveEstadoChat(sender, remoteJid);
            limparTimeoutTestar(sender, remoteJid);
            temporizadoresTestar[chave] = setTimeout(async () => {
                if (aguardandoAcaoTestar[chave]) {
                    delete aguardandoAcaoTestar[chave];
                    delete temporizadoresTestar[chave];
                    try {
                        await sock.sendMessage(remoteJid, { text: '⏱ *Tempo esgotado!* A alteração do modo de testes foi cancelada por inatividade (30 segundos).' });
                    } catch (err) {}
                }
            }, 30000);
        }

        function limparTimeoutAviso(chave) {
            if (temporizadoresAviso[chave]) {
                clearTimeout(temporizadoresAviso[chave]);
                delete temporizadoresAviso[chave];
            }
        }

        function limparTimeoutGPDinheiro(sender, remoteJid) {
            const chave = remoteJid ? chaveEstadoChat(sender, remoteJid) : sender;
            if (temporizadoresGPDinheiro[chave]) {
                clearTimeout(temporizadoresGPDinheiro[chave]);
                delete temporizadoresGPDinheiro[chave];
            }
        }

        function definirTimeoutGPDinheiro(sender, remoteJid) {
            const chave = chaveEstadoChat(sender, remoteJid);
            limparTimeoutGPDinheiro(sender, remoteJid);
            temporizadoresGPDinheiro[chave] = setTimeout(async () => {
                if (aguardandoGPDinheiro[chave]) {
                    delete aguardandoGPDinheiro[chave];
                    delete temporizadoresGPDinheiro[chave];
                    try {
                        await sock.sendMessage(remoteJid, {
                            text: '⏱ *Tempo esgotado!* A administração de dinheiro foi cancelada por inatividade (60 segundos).'
                        });
                    } catch (err) {}
                }
            }, 60000);
        }

        function limparTimeoutResetGP(sender, remoteJid) {
            const chave = remoteJid ? chaveEstadoChat(sender, remoteJid) : sender;
            if (temporizadoresResetGP[chave]) {
                clearTimeout(temporizadoresResetGP[chave]);
                delete temporizadoresResetGP[chave];
            }
        }

        function definirTimeoutResetGP(sender, remoteJid) {
            const chave = chaveEstadoChat(sender, remoteJid);
            limparTimeoutResetGP(sender, remoteJid);
            temporizadoresResetGP[chave] = setTimeout(async () => {
                if (aguardandoResetGP[chave]) {
                    delete aguardandoResetGP[chave];
                    delete temporizadoresResetGP[chave];
                    try {
                        await sock.sendMessage(remoteJid, {
                            text: '⏱ *Tempo esgotado!* O reset foi cancelado por inatividade (60 segundos).'
                        });
                    } catch (err) {}
                }
            }, 60000);
        }

        async function listarGruposBrincadeiras() {
            const gruposAtivos = [];
            if (!dadosGlobais.brincadeiras) dadosGlobais.brincadeiras = {};

            for (const jid of Object.keys(dadosGlobais.brincadeiras)) {
                if (!dadosGlobais.brincadeiras[jid]) continue;
                try {
                    const meta = await obterMetadadosGrupoComTimeout(jid);
                    gruposAtivos.push({ jid, nome: meta.subject || jid });
                } catch (e) {
                    // Se o bot não consegue mais acessar o grupo, remove o status salvo.
                    delete dadosGlobais.brincadeiras[jid];
                }
            }

            await salvarDadosBot(dadosGlobais).catch(() => {});
            return gruposAtivos;
        }

        function definirTimeoutAviso(chave, remoteJid) {
            limparTimeoutAviso(chave);
            temporizadoresAviso[chave] = setTimeout(async () => {
                if (aguardandoAcaoAviso[chave]) {
                    delete aguardandoAcaoAviso[chave];
                    delete temporizadoresAviso[chave];
                    try {
                        await sock.sendMessage(remoteJid, {
                            text: '⏱ *Tempo esgotado!* O processo de aviso foi cancelado por inatividade (30 segundos).\n\nO texto (se já tiver sido digitado) continua salvo.'
                        });
                    } catch (err) {}
                }
            }, 30000);
        }

        function limparEstadosPendentes(sender, remoteJid) {
            const chave = remoteJid ? chaveEstadoChat(sender, remoteJid) : sender;
            limparTimeoutLog(sender, remoteJid);
            delete aguardandoAcaoLog[chave];
            limparTimeoutTestar(sender, remoteJid);
            delete aguardandoAcaoTestar[chave];
            limparTimeoutAviso(remoteJid || sender);
            delete aguardandoAcaoAviso[remoteJid || sender];
            limparTimeoutGPDinheiro(sender, remoteJid);
            delete aguardandoGPDinheiro[chave];
            limparTimeoutResetGP(sender, remoteJid);
            delete aguardandoResetGP[chave];
        }

        async function listarGruposComAvisos() {
            const gruposAtivos = [];
            for (const jid in dadosGlobais.gruposAvisos) {
                if (dadosGlobais.gruposAvisos[jid] && ['pg', 'gc'].includes(dadosGlobais.statusAluguelGrupos?.[jid])) {
                    try {
                        const meta = await obterMetadadosGrupoComTimeout(jid);
                        gruposAtivos.push({ jid, nome: meta.subject });
                    } catch (e) {
                        delete dadosGlobais.gruposAvisos[jid];
                    }
                }
            }
            if (Object.keys(dadosGlobais.gruposAvisos).length !== Object.keys(dadosGlobais.gruposAvisos).filter(k => dadosGlobais.gruposAvisos[k]).length) {
                await salvarDadosBot(dadosGlobais);
            }
            return gruposAtivos;
        }


        function registrarModificacaoGrupo(groupJid, autor, acao, participantes = [], detalhes = '') {
            if (!dadosGlobais.verQuemModificou?.[groupJid]) return;
            if (!dadosGlobais.logsModificacoesGrupo) dadosGlobais.logsModificacoesGrupo = {};
            if (!dadosGlobais.logsModificacoesGrupo[groupJid]) dadosGlobais.logsModificacoesGrupo[groupJid] = [];

            const entrada = {
                autor: autor || 'desconhecido',
                acao,
                participantes: Array.isArray(participantes) ? participantes : [],
                detalhes,
                timestamp: Date.now()
            };

            dadosGlobais.logsModificacoesGrupo[groupJid].unshift(entrada);
            dadosGlobais.logsModificacoesGrupo[groupJid] =
                dadosGlobais.logsModificacoesGrupo[groupJid].slice(0, 30);
        }

        function descricaoModificacaoGrupo(autor, acao, participantes = [], detalhes = '') {
            const quem = autor && autor.includes('@')
                ? `@${normalizarJid(autor)}`
                : `@${normalizarJid(autor || 'desconhecido')}`;

            const nomes = participantes.map(jid => `@${normalizarJid(jid)}`).join(', ');

            if (acao === 'add') return `➕ ${quem} adicionou ${nomes || 'participante(s)'} ao grupo.`;
            if (acao === 'remove') return `➖ ${quem} removeu ${nomes || 'participante(s)'} do grupo.`;
            if (acao === 'promote') return `👑 ${quem} promoveu ${nomes || 'participante(s)'} a administrador.`;
            if (acao === 'demote') return `🔻 ${quem} rebaixou ${nomes || 'participante(s)'} de administrador.`;
            if (acao === 'modify') return `🛠️ ${quem} modificou um participante${nomes ? `: ${nomes}` : '.'}`;
            if (acao === 'group-update') return `⚙️ ${quem} alterou ${detalhes || 'as configurações do grupo'}.`;
            return `⚙️ ${quem} realizou uma alteração no grupo${detalhes ? `: ${detalhes}` : '.'}`;
        }

        async function notificarModificacaoGrupo(groupJid, autor, acao, participantes = [], detalhes = '') {
            if (!['pg', 'gc'].includes(dadosGlobais.statusAluguelGrupos?.[groupJid])) return;
            if (!dadosGlobais.verQuemModificou?.[groupJid]) return;
            registrarModificacaoGrupo(groupJid, autor, acao, participantes, detalhes);
            const mencoes = [];
            if (autor) mencoes.push(autor);
            for (const p of participantes) if (p && !mencoes.includes(p)) mencoes.push(p);

            await sock.sendMessage(groupJid, {
                text: `🔎 *ALTERAÇÃO NO GRUPO DETECTADA*\n\n${descricaoModificacaoGrupo(autor, acao, participantes, detalhes)}`,
                mentions: mencoes
            }).catch(() => {});
            await salvarDadosBot(dadosGlobais).catch(() => {});
        }

        function criarStatsXP() {
            return { xp: 0, nivel: 1, msgCount: 0 };
        }

        function obterStatsXP(userGroupKey) {
            if (!dadosGlobais.xpStatus) dadosGlobais.xpStatus = {};
            if (!dadosGlobais.xpStatus[userGroupKey]) {
                dadosGlobais.xpStatus[userGroupKey] = criarStatsXP();
            }

            const stats = dadosGlobais.xpStatus[userGroupKey];
            stats.xp = Number.isFinite(Number(stats.xp)) ? Math.max(0, Number(stats.xp)) : 0;
            stats.nivel = Number.isFinite(Number(stats.nivel))
                ? Math.min(XP_MAX_LEVEL, Math.max(1, Number(stats.nivel)))
                : 1;
            stats.msgCount = Number.isFinite(Number(stats.msgCount)) ? Math.max(0, Number(stats.msgCount)) : 0;
            return stats;
        }

        function xpNecessarioNivel(nivel) {
            return nivel >= XP_MAX_LEVEL ? 0 : nivel * 25;
        }

        function aplicarXP(stats, quantidade) {
            let restante = Math.max(0, Math.floor(Number(quantidade) || 0));
            let levelsGanhos = 0;

            while (restante > 0 && stats.nivel < XP_MAX_LEVEL) {
                const necessario = xpNecessarioNivel(stats.nivel);
                const disponivel = necessario - stats.xp;

                if (restante < disponivel) {
                    stats.xp += restante;
                    restante = 0;
                    break;
                }

                restante -= disponivel;
                stats.xp = 0;
                stats.nivel++;
                levelsGanhos++;
            }

            // Não deixa XP "vazar" depois do nível 30.
            if (stats.nivel >= XP_MAX_LEVEL) {
                stats.nivel = XP_MAX_LEVEL;
                stats.xp = 0;
            }

            return levelsGanhos;
        }

        // Recompensa por subir de nível:
        // Nível 1 -> 2 = R$ 30
        // Nível 2 -> 3 = R$ 60
        // Nível 3 -> 4 = R$ 90
        // e assim por diante. Se subir vários níveis de uma vez, soma todas as recompensas.
        function calcularRecompensaNivel(nivelAntes, nivelDepois) {
            let recompensa = 0;
            const inicio = Math.max(1, Number(nivelAntes) || 1);
            const fim = Math.min(XP_MAX_LEVEL, Number(nivelDepois) || inicio);
            for (let nivel = inicio + 1; nivel <= fim; nivel++) {
                recompensa += (nivel - 1) * 30;
            }
            return recompensa;
        }

        function adicionarRecompensaNivel(chave, nivelAntes, nivelDepois) {
            const recompensa = calcularRecompensaNivel(nivelAntes, nivelDepois);
            if (recompensa <= 0) return 0;
            if (!dadosGlobais.economia) dadosGlobais.economia = {};
            if (!dadosGlobais.economia[chave]) {
                dadosGlobais.economia[chave] = { dinheiro: 100, lastWork: 0, lastRob: 0 };
            }
            dadosGlobais.economia[chave].dinheiro =
                (Number(dadosGlobais.economia[chave].dinheiro) || 0) + recompensa;
            return recompensa;
        }

        function precoComprarXP(quantidade) {
            if (quantidade === 10) return PRECO_XP_10;
            if (quantidade === 20) return PRECO_XP_20;
            if (quantidade >= 30 && quantidade <= 100) return quantidade * PRECO_XP_POR_UNIDADE_ACIMA_20;
            return null;
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update || {};

            if (connection === 'close') {
                // A troca manual ou um socket obsoleto não deve iniciar outra reconexão.
                if (trocaManualEmAndamento || sockAtual !== sock) return;

                // O estado cai imediatamente: não deixe o timer de estabilidade ou .ping
                // continuar afirmando que está conectado enquanto uma operação assíncrona aguarda.
                socketsEncerrados.add(sock);
                socketAberto = false;
                if (temporizadorConexaoEstavel) { clearTimeout(temporizadorConexaoEstavel); temporizadorConexaoEstavel = null; }
                if (temporizadorAberturaSocket) { clearTimeout(temporizadorAberturaSocket); temporizadorAberturaSocket = null; }
                if (temporizadorRetryCodigo) { clearTimeout(temporizadorRetryCodigo); temporizadorRetryCodigo = null; }
                limparTemporizadorReciclagemSocket();

                // Garante que creds.update precedente seja gravado antes de abrir outro socket.
                try {
                    await promessaSalvarCredenciais;
                } catch (erroCredenciais) {
                    console.error('[SESSÃO] A gravação de credenciais falhou antes da reconexão:', erroCredenciais?.message || erroCredenciais);
                }
                // Enquanto aguardávamos a gravação, um comando do terminal pode ter
                // trocado o método/socket; o evento antigo não deve interferir no novo.
                if (trocaManualEmAndamento || sockAtual !== sock) return;
                if (temporizadorRetryCodigo) {
                    clearTimeout(temporizadorRetryCodigo);
                    temporizadorRetryCodigo = null;
                }

                // O estado e os temporizadores já foram invalidados antes da espera acima.

                // O formato do erro muda entre versões do Baileys. Leia o status
                // nos caminhos conhecidos para que um 401 nunca passe despercebido.
                const codigoBruto = lastDisconnect?.error?.output?.statusCode
                    ?? lastDisconnect?.error?.statusCode
                    ?? lastDisconnect?.error?.cause?.output?.statusCode
                    ?? lastDisconnect?.error?.cause?.statusCode
                    ?? lastDisconnect?.error?.data?.statusCode;
                const codigo = Number.isFinite(Number(codigoBruto)) ? Number(codigoBruto) : codigoBruto;
                const erroOriginalFechamento = lastDisconnect?.error;
                const erroFechamento = erroOriginalFechamento?.message || 'motivo não informado';
                console.error(`[CONEXÃO] ⚠️ Socket fechado. Código: ${codigo ?? 'desconhecido'} | Motivo: ${erroFechamento}`);
                const payloadFechamento = erroOriginalFechamento?.output?.payload;
                if (payloadFechamento && typeof payloadFechamento === 'object') {
                    console.error('[CONEXÃO] Detalhe Baileys:', JSON.stringify({
                        payloadStatus: payloadFechamento.statusCode ?? null,
                        payloadError: payloadFechamento.error ?? null,
                        payloadMessage: payloadFechamento.message ?? null,
                        isServer: erroOriginalFechamento?.isServer ?? null
                    }));
                }

                // 515 / restartRequired é emitido pelo WhatsApp em fluxos de pareamento
                // que precisam reabrir o socket com as credenciais recém-gravadas.
                const codigoRestartRequired = Number(DisconnectReason.restartRequired);
                if (Number(codigo) === 515 || (Number.isFinite(codigoRestartRequired) && Number(codigo) === codigoRestartRequired)) {
                    if (!state.creds.registered && ['codigo', 'qr'].includes(modoConexao)) {
                        // Se o pareamento ainda não concluiu, preserve a escolha e o número.
                        modoConexaoForcado = modoConexao;
                        numeroPareamentoForcado = modoConexao === 'codigo' ? numeroPareamento : '';
                    }
                    console.warn(state.creds.registered
                        ? '[SESSÃO] O WhatsApp solicitou reiniciar após atualizar as credenciais. Reconectando imediatamente.'
                        : '[PAREAMENTO] O WhatsApp solicitou uma nova conexão durante o pareamento. Vou continuar usando o mesmo método.');
                    agendarReconexao('WhatsApp solicitou reinício do socket (515/restartRequired)', 0);
                    return;
                }

                // Em outros fechamentos durante o pareamento, preserve o método escolhido
                // para que uma queda de rede não obrigue o usuário a responder tudo de novo.
                if (!state.creds.registered && ['codigo', 'qr'].includes(modoConexao)) {
                    modoConexaoForcado = modoConexao;
                    numeroPareamentoForcado = modoConexao === 'codigo' ? numeroPareamento : '';
                }

                // 428 sozinho não comprova sessão corrompida nem bloqueio por excesso de tentativas.
                // Preservamos a autenticação; a espera progressiva pode chegar a 60 segundos.
                if (Number(codigo) === 428) {
                    const tentativas428 = Math.max(0, Number(tentativasReconexaoConsecutivas) || 0);
                    const base428 = Math.min(60_000, 5_000 * (2 ** Math.min(tentativas428, 4)));
                    const jitter428 = Math.floor(Math.random() * Math.max(1, Math.floor(base428 * 0.2)));
                    const espera428 = Math.min(60_000, base428 + jitter428);
                    console.warn(
                        `[CONEXÃO] O Baileys informou 428 (Connection Terminated). ` +
                        `A autenticação será preservada; nova tentativa em ${Math.ceil(espera428 / 1000)}s. ` +
                        'A espera aumenta em ciclos repetidos para não insistir rapidamente contra o servidor.'
                    );
                    agendarReconexao('WebSocket encerrado (428)', espera428);
                    return;
                }

                // Quando a autenticação foi revogada/corrompida, arquiva a pasta velha
                // e prepara uma pasta limpa para pedir um novo pareamento. Isso não ocorre
                // em quedas de internet nem em simples substituições do socket.
                const codigosSessaoInvalida = new Set([
                    DisconnectReason.loggedOut,
                    DisconnectReason.badSession,
                    DisconnectReason.multideviceMismatch
                ].filter((v) => v !== undefined));

                // 401 é o status loggedOut no Baileys e exige novo pareamento.
                // O teste explícito cobre também versões que não expõem a constante.
                if (codigosSessaoInvalida.has(codigo) || Number(codigo) === 401) {
                    if (temporizadorConexaoEstavel) {
                        clearTimeout(temporizadorConexaoEstavel);
                        temporizadorConexaoEstavel = null;
                    }
                    sockAtual = null;
                    encerrarSocketAntigo(sock, 'sessão inválida');
                    reconexaoEmAndamento = false;
                    console.error('[SESSÃO] 🔴 O WhatsApp informou que a autenticação atual não pode ser reutilizada.');
                    const arquivada = await arquivarSessaoInvalida(erroFechamento, state);
                    if (arquivada) {
                        agendarReconexao('autenticação inválida; será necessário parear novamente', 1500);
                    } else {
                        console.error('[SESSÃO] Parei a recuperação automática para evitar um ciclo de conexões sem autenticação válida.');
                    }
                    return;
                }

                if (codigo === DisconnectReason.forbidden) {
                    sockAtual = null;
                    encerrarSocketAntigo(sock, 'acesso recusado');
                    reconexaoEmAndamento = false;
                    if (!jaExibiuMensagemSemInternet) {
                        console.warn('[CONEXÃO] O WhatsApp recusou esta tentativa. Vou tentar novamente com espera progressiva, sem apagar a sessão; se persistir, será necessário conferir a conta e a versão do Baileys.');
                    }
                    // Não deixa o bot permanecer parado indefinidamente, mas também
                    // não destrói a autenticação por um erro de acesso transitório.
                    agendarReconexao('WhatsApp recusou a conexão (forbidden)');
                    return;
                }

                let esperaForcada = null;
                if (codigo === DisconnectReason.connectionReplaced) {
                    substituicoesSessaoConsecutivas += 1;
                    if (substituicoesSessaoConsecutivas > 1) {
                        console.error('⚠️ A sessão foi substituída repetidamente. Isso costuma indicar outro ArleyBot usando a mesma sessão; encerre a instância duplicada. A próxima tentativa será mais espaçada.');
                        esperaForcada = 60_000;
                    } else {
                        console.warn('⚠️ Sessão substituída detectada. Vou fechar o socket antigo e tentar reconectar. Se repetir, verifique se há outra instância do ArleyBot aberta.');
                    }
                }

                if (temporizadorConexaoEstavel) {
                    clearTimeout(temporizadorConexaoEstavel);
                    temporizadorConexaoEstavel = null;
                }

                // Continua tentando em vez de deixar o bot parado e sem responder.
                agendarReconexao(erroFechamento, esperaForcada);
            } else if (connection === 'open') {
                // Um socket antigo/fechado ou um evento duplicado não pode repetir a inicialização.
                if (sockAtual !== sock || socketsEncerrados.has(sock) || eventoOpenConcluido || processamentoEventoOpen) return;
                processamentoEventoOpen = true;
                // Garantia extra: persistir as credenciais no momento em que a sessão abre.
                // Isso reduz a chance de o próximo npm start interpretar o login como novo.
                try {
                    await enfileirarSalvamentoCredenciais();
                } catch (erroSalvarAoAbrir) {
                    console.error('[SESSÃO] ⚠️ Não consegui confirmar a gravação das credenciais ao conectar:', erroSalvarAoAbrir?.message || erroSalvarAoAbrir);
                }
                // Durante o await acima, o socket pode ter fechado ou sido substituído.
                // Nunca marque como conectado um socket antigo ou o worker em encerramento.
                if (sockAtual !== sock || encerrandoWorker || socketsEncerrados.has(sock)) {
                    processamentoEventoOpen = false;
                    return;
                }
                processamentoEventoOpen = false;
                eventoOpenConcluido = true;
                socketAberto = true;
                // Se o bot reiniciou enquanto havia um grupo novo pendente, tenta enviar
                // os botões privados novamente somente depois que o WebSocket abriu.
                for (const [jidPendente, pedidoPendente] of Object.entries(dadosGlobais.gruposAguardandoAutorizacao || {})) {
                    if (!pedidoPendente) continue;
                    const statusPendente = String(dadosGlobais.statusAluguelGrupos?.[jidPendente] || '').toLowerCase();
                    if (['pg', 'gc'].includes(statusPendente)) {
                        limparAutorizacaoPendenteGrupo(jidPendente);
                        void salvarDadosBot(dadosGlobais).catch(() => {});
                        continue;
                    }
                    if (statusPendente === 'npg' || (Number(pedidoPendente.expiraEm) > 0 && Number(pedidoPendente.expiraEm) <= Date.now())) {
                        const timerSaida = temporizadoresAutorizacaoGrupo.get(jidPendente);
                        if (timerSaida?.timer) clearTimeout(timerSaida.timer);
                        temporizadoresAutorizacaoGrupo.delete(jidPendente);
                        void tentarSairGrupoSemConfiguracao(jidPendente);
                        continue;
                    }
                    iniciarPrazoAutorizacaoGrupo(jidPendente);
                    if (!pedidoPendente.avisoDonoEnviado) void enviarSolicitacaoConfiguracaoAoDono(jidPendente);
                }
                limparTemporizadorReciclagemSocket();
                if (INTERVALO_RECICLAGEM_SOCKET_MS > 0) {
                    temporizadorReciclagemSocket = setTimeout(() => {
                        temporizadorReciclagemSocket = null;
                        if (sockAtual !== sock || !socketAberto || trocaManualEmAndamento) return;
                        console.warn(`[CONEXÃO] ♻️ Reciclagem preventiva após ${HORAS_RECICLAGEM_SOCKET}h conectadas. Vou fechar este socket e abrir outro mantendo a autenticação.`);
                        agendarReconexao('reciclagem preventiva do socket', 2000);
                    }, INTERVALO_RECICLAGEM_SOCKET_MS);
                    temporizadorReciclagemSocket.unref?.();
                }
                if (temporizadorAberturaSocket) {
                    clearTimeout(temporizadorAberturaSocket);
                    temporizadorAberturaSocket = null;
                }
                trocarMetodoTerminal = null;
                modoConexaoForcado = null;
                numeroPareamentoForcado = '';
                reconexaoEmAndamento = false;
                if (temporizadorRetryCodigo) {
                    clearTimeout(temporizadorRetryCodigo);
                    temporizadorRetryCodigo = null;
                }
                if (temporizadorConexaoEstavel) clearTimeout(temporizadorConexaoEstavel);
                temporizadorConexaoEstavel = null;
                // O bot pode anunciar que está pronto após 20s, mas uma conexão
                // que fecha pouco depois não deve zerar o backoff de reconexão.
                // Só zeramos as tentativas após 5 minutos contínuos de conexão.
                temporizadorConexaoEstavel = setTimeout(() => {
                    if (sockAtual !== sock || !socketAberto) {
                        temporizadorConexaoEstavel = null;
                        return;
                    }
                    console.log(`✅ ArleyBot ${ARLEYBOT_VERSION} conectado e pronto para receber comandos (conexão estável por 20s) | BUILD ${ARLEYBOT_BUILD_ID} | ${__filename}`);
                    temporizadorConexaoEstavel = setTimeout(() => {
                        if (sockAtual === sock && socketAberto) {
                            tentativasReconexaoConsecutivas = 0;
                            substituicoesSessaoConsecutivas = 0;
                            jaExibiuMensagemSemInternet = false;
                            console.log('[CONEXÃO] Sessão permaneceu conectada por 5 minutos; contador de reconexões reiniciado.');
                        }
                        temporizadorConexaoEstavel = null;
                    }, 5 * 60 * 1000 - 20000);
                }, 20000);
                console.log(`[CONEXÃO] Socket aberto; aguardando 20 segundos de estabilidade antes de confirmar que o bot está pronto | BUILD ${ARLEYBOT_BUILD_ID}`);
                // Solicita ocultação de presença: online segue a configuração de visto por último.
                // Isso também oculta o 'visto por último'; o WhatsApp pode limitar a eficácia
                // quando um dispositivo conectado permanece com uma sessão ativa.
                try {
                    if (typeof sock.updateLastSeenPrivacy === 'function') {
                        await sock.updateLastSeenPrivacy('none');
                    }
                    if (typeof sock.updateOnlinePrivacy === 'function') {
                        await sock.updateOnlinePrivacy('match_last_seen');
                    }
                    await sock.sendPresenceUpdate('unavailable').catch(() => {});
                } catch (erroPrivacidade) {
                    console.warn('⚠️ Não foi possível atualizar a privacidade online automaticamente:', erroPrivacidade?.message || erroPrivacidade);
                    await sock.sendPresenceUpdate('unavailable').catch(() => {});
                }

                // O marcador sobrevive ao encerramento do worker e só é removido
                // depois de o aviso de retorno ser enviado com sucesso.
                try {
                    const avisoSalvo = JSON.parse(await readFile(ARQUIVO_AVISO_RESTART, 'utf8'));
                    const idadeAvisoMs = Date.now() - (Number(avisoSalvo.criadoEm) || 0);
                    if (!avisoSalvo.remoteJid || idadeAvisoMs > 30 * 60 * 1000) {
                        await unlink(ARQUIVO_AVISO_RESTART).catch(() => {});
                    } else {
                        await sock.sendMessage(avisoSalvo.remoteJid, {
                            text: `✅ *ARLEYBOT VOLTOU DO RESTART!* 🔄\n\nA conexão foi restabelecida e já estou pronto para receber comandos.\n📌 Motivo: ${avisoSalvo.motivo || 'reinício solicitado por um administrador'}.`
                        });
                        await unlink(ARQUIVO_AVISO_RESTART).catch(() => {});
                        // Aviso de retorno confirmado, sem log redundante.
                    }
                } catch (erroAvisoRetorno) {
                    if (erroAvisoRetorno?.code !== 'ENOENT') {
                        console.warn('[RESTART] Não consegui enviar o aviso de retorno; tentarei na próxima conexão:', erroAvisoRetorno?.message || erroAvisoRetorno);
                    }
                }
            }
        });

        // creds.update é salvo pelo ouvinte antecipado e serializado acima.

        sock.ev.on('group-participants.update', async (update) => {
            if (sockAtual !== sock || socketsEncerrados.has(sock)) return;
            try {
                const { id, participants = [], action, author } = update || {};
                if (!id) return;

                if (action === 'remove') {
                    if (!removidosRecentes[id]) {
                        if (Object.keys(removidosRecentes).length >= 1000) delete removidosRecentes[Object.keys(removidosRecentes)[0]];
                        removidosRecentes[id] = [];
                    }
                    for (const participante of participants) {
                        removidosRecentes[id] = [participante, ...removidosRecentes[id].filter(j => j !== participante)].slice(0, 5);
                    }
                }

                // Se adicionarem o próprio bot a um grupo não cadastrado, avisa e inicia
                // o prazo de um minuto. O prazo é cancelado quando o dono usa pg/gc/npg.
                if (action === 'add' && participants.length) {
                    // Baileys recente pode entregar { id, phoneNumber, lid } em vez de strings.
                    // Também pode identificar a própria conta do bot por @lid, dependendo do grupo.
                    let botFoiAdicionado = false;
                    for (const participante of participants) {
                        if (await participanteEhBot(participante)) {
                            botFoiAdicionado = true;
                            break;
                        }
                    }
                    // A resolução LID pode ser assíncrona; um evento atrasado de socket velho
                    // não pode alterar PG/GC/NPG depois que outra conexão assumir o controle.
                    if (sockAtual !== sock || socketsEncerrados.has(sock)) return;
                    if (botFoiAdicionado) {
                        const statusEntrada = String(dadosGlobais.statusAluguelGrupos?.[id] || '').toLowerCase();
                        if (['pg', 'gc'].includes(statusEntrada)) {
                            limparAutorizacaoPendenteGrupo(id);
                            await salvarDadosBot(dadosGlobais).catch(() => {});
                        } else if (statusEntrada === 'npg') {
                            if (!dadosGlobais.gruposAguardandoAutorizacao) dadosGlobais.gruposAguardandoAutorizacao = {};
                            if (!dadosGlobais.gruposAguardandoAutorizacao[id]) {
                                dadosGlobais.gruposAguardandoAutorizacao[id] = {
                                    criadoEm: Date.now(), expiraEm: Date.now(), avisoDonoEnviado: true,
                                    motivoSaida: 'npg', saidaPendente: true, nome: id
                                };
                            }
                            await salvarDadosBot(dadosGlobais).catch(() => {});
                            iniciarPrazoAutorizacaoGrupo(id);
                            if (Number(dadosGlobais.gruposAguardandoAutorizacao[id]?.expiraEm) > Date.now()) {
                                dadosGlobais.gruposAguardandoAutorizacao[id].expiraEm = Date.now();
                            }
                            const timerSaida = temporizadoresAutorizacaoGrupo.get(id);
                            if (timerSaida?.timer) clearTimeout(timerSaida.timer);
                            temporizadoresAutorizacaoGrupo.delete(id);
                            await tentarSairGrupoSemConfiguracao(id);
                            return;
                        } else {
                            if (!dadosGlobais.gruposAguardandoAutorizacao) dadosGlobais.gruposAguardandoAutorizacao = {};
                            if (!dadosGlobais.gruposAguardandoAutorizacao[id]) {
                                dadosGlobais.gruposAguardandoAutorizacao[id] = {
                                    criadoEm: Date.now(),
                                    expiraEm: Date.now() + PRAZO_AUTORIZACAO_GRUPO_MS,
                                    avisoDonoEnviado: false,
                                    nome: id
                                };
                                await salvarDadosBot(dadosGlobais).catch(erro => {
                                    console.warn('[AUTORIZAÇÃO] Não consegui salvar a pendência inicial do grupo:', erro?.message || erro);
                                });
                            }
                            iniciarPrazoAutorizacaoGrupo(id);
                            await enviarSolicitacaoConfiguracaoAoDono(id);
                            await avisarGrupoBloqueado(id, statusEntrada, { force: true });
                        }
                    }
                }

                // O bot não envia boas-vindas nem modera eventos em grupos bloqueados/não cadastrados.
                if (!['pg', 'gc'].includes(dadosGlobais.statusAluguelGrupos?.[id])) return;

                if (action === 'add' && dadosGlobais.bemVindoGrupos?.[id] === true && participants.length) {
                    let metadata = null;
                    try { metadata = await obterMetadadosGrupoComTimeout(id, 8000); } catch (_) {}
                    const nomeGrupo = String(metadata?.subject || 'este grupo')
                        .replace(/[\r\n]+/g, ' ')
                        .replace(/\*/g, '')
                        .slice(0, 100);
                    const botNumero = normalizarJid(getBotJid());
                    const listaParticipantes = [...new Set(participants.filter(Boolean).map(String))];

                    for (const participanteEvento of listaParticipantes) {
                        // Não saúda a própria conta do bot quando ela é adicionada ao grupo.
                        if (normalizarJid(participanteEvento) === botNumero) continue;
                        let jidMencao = participanteEvento;
                        const dadosParticipante = (metadata?.participants || []).find(p => {
                            const ids = [p?.id, p?.jid, p?.phoneNumber, p?.lid].filter(Boolean).map(String);
                            return ids.includes(participanteEvento) || ids.some(jid => normalizarJid(jid) === normalizarJid(participanteEvento));
                        });
                        jidMencao = dadosParticipante?.phoneNumber || dadosParticipante?.jid || dadosParticipante?.id || participanteEvento;
                        const numMencao = normalizarJid(jidMencao);
                        const legendaBoasVindas = `🎉 *BEM-VINDO(A)!* 🎉\n\n` +
                            `👋 Olá, @${numMencao}!\n` +
                            `🏡 Você entrou no grupo *${nomeGrupo}*.\n\n` +
                            `Que bom ter você aqui! 💚`;

                        let fotoBuffer = null;
                        try {
                            const urlFoto = await sock.profilePictureUrl(jidMencao, 'image').catch(() => null);
                            if (urlFoto) {
                                const respostaFoto = await fetch(urlFoto, { signal: AbortSignal.timeout(8000) });
                                if (respostaFoto.ok) {
                                    const tamanhoDeclarado = Number(respostaFoto.headers.get('content-length')) || 0;
                                    if (tamanhoDeclarado > 0 && tamanhoDeclarado <= 6 * 1024 * 1024) {
                                        const arrayFoto = await respostaFoto.arrayBuffer();
                                        if (arrayFoto.byteLength > 0 && arrayFoto.byteLength <= 6 * 1024 * 1024) fotoBuffer = Buffer.from(arrayFoto);
                                    } else if (!tamanhoDeclarado) {
                                        const arrayFoto = await respostaFoto.arrayBuffer();
                                        if (arrayFoto.byteLength > 0 && arrayFoto.byteLength <= 6 * 1024 * 1024) fotoBuffer = Buffer.from(arrayFoto);
                                    }
                                }
                            }
                        } catch (erroFotoBoasVindas) {
                            console.warn('[BEM-VINDO] Não consegui buscar a foto de perfil; enviarei a saudação sem foto:', erroFotoBoasVindas?.message || erroFotoBoasVindas);
                        }

                        // A saudação usa a foto de perfil do novo membro e o nome do grupo; nunca a descrição.
                        try {
                            if (fotoBuffer) {
                                await sock.sendMessage(id, {
                                    image: fotoBuffer,
                                    mimetype: 'image/jpeg',
                                    caption: legendaBoasVindas,
                                    mentions: [jidMencao]
                                });
                            } else {
                                await sock.sendMessage(id, { text: legendaBoasVindas, mentions: [jidMencao] });
                            }
                        } catch (erroEnvioBoasVindas) {
                            console.warn('[BEM-VINDO] Não consegui enviar a saudação:', erroEnvioBoasVindas?.message || erroEnvioBoasVindas);
                        }
                    }
                }

                if (dadosGlobais.verQuemModificou?.[id]) {
                    await notificarModificacaoGrupo(id, author, action, participants || [], '');
                }
            } catch (erroEventoParticipantes) {
                console.error('[GRUPO] Falha ao processar entrada/saída de participante:', erroEventoParticipantes?.stack || erroEventoParticipantes?.message || erroEventoParticipantes);
            }
        });
        // Alterações de nome, descrição, permissões, modo de adicionar membros,
        // aprovação de entrada e outras configurações carregadas pelo Baileys.
        sock.ev.on('groups.update', async (updates) => {
            if (sockAtual !== sock || socketsEncerrados.has(sock)) return;
            for (const update of updates || []) {
                const id = update.id;
                if (id && Object.prototype.hasOwnProperty.call(update, 'subject')) {
                    const nomeAtualizado = limparTextoTerminal(update.subject, 80);
                    if (nomeAtualizado) cacheNomeGrupoTerminal.set(id, {
                        nome: nomeAtualizado,
                        expiraEm: Date.now() + TTL_NOME_GRUPO_TERMINAL_MS
                    });
                }
                if (!id || !['pg', 'gc'].includes(dadosGlobais.statusAluguelGrupos?.[id]) || !dadosGlobais.verQuemModificou?.[id]) continue;

                const detalhes = [];
                if (Object.prototype.hasOwnProperty.call(update, 'subject')) detalhes.push(`nome do grupo para "${update.subject}"`);
                if (Object.prototype.hasOwnProperty.call(update, 'desc')) detalhes.push('descrição do grupo');
                if (Object.prototype.hasOwnProperty.call(update, 'announce')) detalhes.push(update.announce ? 'modo somente administradores para enviar mensagens' : 'modo de mensagens para todos');
                if (Object.prototype.hasOwnProperty.call(update, 'restrict')) detalhes.push(update.restrict ? 'somente administradores podem alterar configurações' : 'alterações de configurações liberadas');
                if (Object.prototype.hasOwnProperty.call(update, 'memberAddMode')) detalhes.push(update.memberAddMode ? 'permissão para membros adicionarem pessoas' : 'permissão de adicionar membros');
                if (Object.prototype.hasOwnProperty.call(update, 'joinApprovalMode')) detalhes.push(update.joinApprovalMode ? 'aprovação de entrada' : 'aprovação de entrada');
                if (Object.prototype.hasOwnProperty.call(update, 'inviteCode')) detalhes.push('link de convite');

                if (detalhes.length === 0) continue;

                await notificarModificacaoGrupo(
                    id,
                    update.author,
                    'group-update',
                    [],
                    detalhes.join(', ')
                );
            }
        });

        const prefix = '.';
        const PREFIXO_PADRAO = '.';
        function validarPrefixoPersonalizado(valor) {
            const candidato = String(valor ?? '').trim();
            if (candidato.length < 1 || candidato.length > 3) return null;
            // Prefixos devem ser símbolos, não palavras; comandos sem prefixo nunca são executados.
            if (/[\p{L}\p{N}\s]/u.test(candidato)) return null;
            return candidato;
        }
        function obterPrefixoChat(remoteJid) {
            if (!String(remoteJid || '').endsWith('@g.us')) return PREFIXO_PADRAO;
            const salvo = validarPrefixoPersonalizado(dadosGlobais.prefixosGrupos?.[remoteJid]);
            return salvo || PREFIXO_PADRAO;
        }

        // Permissões centralizadas: comandos do dono não são herdados pelos admins;
        // comandos de administração do grupo podem ser usados por admins e pelo dono.
        const COMANDOS_EXCLUSIVOS_DONO = new Set([
            'setlog', 'settat', 'setteste',
            'dono', 'centraldono', 'menuowner', 'menuadmin',
            'testar', 'aviso', 'reaviso',
            'gp', 'gpdinheiro', 'resetgp', 'resetgpdinheiro',
            'pg', 'npg', 'gc',
            'desligar', 'ligar'
        ]);
        const COMANDOS_ADMIN_GRUPO = new Set([
            'restart',
            'brincadeiras1', 'brincadeiras0',
            'ativarmsgale1', 'ativarmsgale0', 'ativatmsgale0',
            'ativarverquemmodificou1', 'ativarverquemmodificou0', 'verquemmodificou',
            'avisoson', 'avisosoff', 'acmd', 'antispam',
            'mute', 'unmute', 'unmuteall',
            'apagar', 'd', 'fixar', 'pin',
            'promover', 'promote', 'rebaixar', 'demote', 'ban', 'kick', 'add', 'prefixo', 'bem-vindo', 'bemvindo',
            'fechar', 'abrir', 'ngrp', 'dgrp', 'admgrupo', 'icon', 'antiporno', 'nfsw1'
        ]);

        async function obterParticipantes(remoteJid) {
            const metadata = await obterMetadadosGrupoComTimeout(remoteJid);
            return metadata.participants;
        }

        // Cache curto para evitar consultar os metadados do grupo em toda mensagem
        // recebida de participantes cujo identificador seja @lid.
        const cacheJidCanonicoGrupo = new Map();
        const TTL_CACHE_JID_GRUPO_MS = 5 * 60 * 1000;

        async function resolverJidCanonicoGrupo(remoteJid, jid, forcarResolucao = false) {
            // Mensagens comuns de participantes com JID de telefone não precisam
            // consultar os metadados. Para alvos marcados, a resolução forçada
            // verifica todos os aliases do participante antes de consultar o banco.
            if (!remoteJid?.endsWith('@g.us') || !jid || (!forcarResolucao && !jid.endsWith('@lid'))) {
                return jid;
            }

            const chaveCache = `${remoteJid}|${jid}`;
            const cacheado = cacheJidCanonicoGrupo.get(chaveCache);
            if (cacheado && Date.now() < cacheado.expiraEm) {
                return cacheado.jid;
            }

            try {
                const metadata = await obterMetadadosGrupoComTimeout(remoteJid);
                const participante = (metadata.participants || []).find(p => {
                    const ids = [p?.id, p?.jid, p?.phoneNumber, p?.lid].filter(Boolean);
                    return ids.includes(jid) || ids.some(id => normalizarJid(id) === normalizarJid(jid));
                });
                const candidatosCanonicos = [participante?.phoneNumber, participante?.jid, participante?.id]
                    .filter(Boolean);
                const jidCanonico = candidatosCanonicos.find(id => !String(id).endsWith('@lid')) || jid;
                cacheJidCanonicoGrupo.set(chaveCache, { jid: jidCanonico, expiraEm: Date.now() + TTL_CACHE_JID_GRUPO_MS });
                if (cacheJidCanonicoGrupo.size > 2000) {
                    const agora = Date.now();
                    for (const [chave, valor] of cacheJidCanonicoGrupo) {
                        if (!valor.expiraEm || valor.expiraEm <= agora) cacheJidCanonicoGrupo.delete(chave);
                    }
                }
                return jidCanonico;
            } catch {
                // Não repetir uma consulta de 8 s a cada mensagem do mesmo @lid.
                cacheJidCanonicoGrupo.set(chaveCache, { jid, expiraEm: Date.now() + 15000 });
                return jid;
            }
        }

        async function migrarDadosIdentidadeGrupo(remoteJid, jidAntigo, jidCanonico) {
            if (!remoteJid?.endsWith('@g.us') || !jidAntigo || !jidCanonico) return false;

            const chaveAntiga = `${remoteJid}_${normalizarJid(jidAntigo)}`;
            const chaveCanonica = `${remoteJid}_${normalizarJid(jidCanonico)}`;
            if (chaveAntiga === chaveCanonica) return false;

            let alterou = false;

            // Nunca sobrescreve um cadastro canônico mais novo com um cadastro @lid antigo.
            // Quando existem os dois, preservamos o maior saldo/maior progresso de XP.
            if (dadosGlobais.economia?.[chaveAntiga]) {
                if (!dadosGlobais.economia) dadosGlobais.economia = {};
                const antigo = dadosGlobais.economia[chaveAntiga];
                const atual = dadosGlobais.economia[chaveCanonica];

                if (!atual) {
                    dadosGlobais.economia[chaveCanonica] = { ...antigo };
                } else {
                    dadosGlobais.economia[chaveCanonica] = {
                        ...atual,
                        dinheiro: Math.max(Number(atual.dinheiro) || 0, Number(antigo.dinheiro) || 0),
                        lastWork: Math.max(Number(atual.lastWork) || 0, Number(antigo.lastWork) || 0),
                        lastRob: Math.max(Number(atual.lastRob) || 0, Number(antigo.lastRob) || 0)
                    };
                }
                delete dadosGlobais.economia[chaveAntiga];
                alterou = true;
            }

            if (dadosGlobais.xpStatus?.[chaveAntiga]) {
                if (!dadosGlobais.xpStatus) dadosGlobais.xpStatus = {};
                const antigo = dadosGlobais.xpStatus[chaveAntiga];
                const atual = dadosGlobais.xpStatus[chaveCanonica];
                const progresso = (st) => ((Number(st?.nivel) || 1) * 100000) + (Number(st?.xp) || 0);

                if (!atual || progresso(antigo) > progresso(atual)) {
                    dadosGlobais.xpStatus[chaveCanonica] = { ...antigo };
                }
                delete dadosGlobais.xpStatus[chaveAntiga];
                alterou = true;
            }



            // Migra também os novos dados do perfil para a identidade canônica.
            const mapasPorChave = [
                'conquistas',
                'progressoJogadores',
                'diarios',
                'missoesJogadores',
                'transacoes',
                'cadastrosBanco',
                'usuariosMutados'
            ];

            for (const nomeMapa of mapasPorChave) {
                if (!dadosGlobais[nomeMapa]) continue;
                if (!dadosGlobais[nomeMapa][chaveAntiga]) continue;
                if (!dadosGlobais[nomeMapa][chaveCanonica]) {
                    dadosGlobais[nomeMapa][chaveCanonica] = dadosGlobais[nomeMapa][chaveAntiga];
                } else if (nomeMapa === 'transacoes') {
                    dadosGlobais[nomeMapa][chaveCanonica] = [
                        ...(dadosGlobais[nomeMapa][chaveCanonica] || []),
                        ...(dadosGlobais[nomeMapa][chaveAntiga] || [])
                    ].sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0)).slice(0, 50);
                } else if (nomeMapa === 'usuariosMutados') {
                    const muteAntigo = dadosGlobais[nomeMapa][chaveAntiga];
                    const muteAtual = dadosGlobais[nomeMapa][chaveCanonica];
                    if (muteAntigo === 'permanente' || muteAtual === 'permanente') {
                        dadosGlobais[nomeMapa][chaveCanonica] = 'permanente';
                    } else if ((Number(muteAntigo) || 0) > (Number(muteAtual) || 0)) {
                        dadosGlobais[nomeMapa][chaveCanonica] = muteAntigo;
                    }
                }
                delete dadosGlobais[nomeMapa][chaveAntiga];
                alterou = true;
            }

            for (const [groupId, temp] of Object.entries(dadosGlobais.temporadas || {})) {
                if (!temp?.pontos?.[chaveAntiga]) continue;
                temp.pontos[chaveCanonica] = Math.max(
                    Number(temp.pontos[chaveCanonica]) || 0,
                    Number(temp.pontos[chaveAntiga]) || 0
                );
                delete temp.pontos[chaveAntiga];
                alterou = true;
            }

            if (alterou) await salvarDadosBot(dadosGlobais).catch(() => {});
            return alterou;
        }

        async function obterChaveCanonicaUsuarioGrupo(remoteJid, jid) {
            const canonico = await resolverJidCanonicoGrupo(remoteJid, jid);
            if (canonico && canonico !== jid) {
                await migrarDadosIdentidadeGrupo(remoteJid, jid, canonico);
            }
            return `${remoteJid}_${normalizarJid(canonico || jid)}`;
        }

        async function obterMencionado(corpoMsg, m) {
            const mencionado = corpoMsg.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (mencionado) return mencionado;
            const quotedParticipant = corpoMsg.extendedTextMessage?.contextInfo?.participant || 
                                      m.message?.extendedTextMessage?.contextInfo?.participant;
            return quotedParticipant || null;
        }

        const cacheAdminGrupo = new Map();
        const TTL_CACHE_ADMIN_GRUPO_MS = 3000;

        async function isAdminGrupo(remoteJid, cleanSender, souDonoFlag) {
            // O dono pode executar comandos administrativos sem precisar ser admin do grupo.
            if (souDonoFlag) return true;
            if (!remoteJid?.endsWith('@g.us') || !cleanSender) return false;

            // O mesmo comando passa pela proteção central e pela validação local.
            // Um cache curto evita duas consultas de metadados e reduz atrasos no Termux.
            const chaveCacheAdmin = `${remoteJid}|${cleanSender}`;
            const cacheAdmin = cacheAdminGrupo.get(chaveCacheAdmin);
            if (cacheAdmin && Date.now() - cacheAdmin.timestamp < TTL_CACHE_ADMIN_GRUPO_MS) {
                return cacheAdmin.isAdmin;
            }

            try {
                const meta = await obterMetadadosGrupoComTimeout(remoteJid);
                const participantes = Array.isArray(meta?.participants) ? meta.participants : [];
                const info = participantes.find(p => {
                    const identificadores = [p?.id, p?.jid, p?.phoneNumber, p?.lid]
                        .filter(Boolean)
                        .map(normalizarJid);
                    return identificadores.includes(String(cleanSender));
                });
                const isAdmin = info?.admin === 'admin' || info?.admin === 'superadmin';
                cacheAdminGrupo.set(chaveCacheAdmin, { isAdmin, timestamp: Date.now() });
                if (cacheAdminGrupo.size > 1500) {
                    const agora = Date.now();
                    for (const [chave, valor] of cacheAdminGrupo) {
                        if (agora - valor.timestamp >= TTL_CACHE_ADMIN_GRUPO_MS) cacheAdminGrupo.delete(chave);
                    }
                }
                return isAdmin;
            } catch {
                return false;
            }
        }

        async function botEhAdminGrupo(remoteJid) {
            if (!remoteJid?.endsWith('@g.us')) return false;
            try {
                const metaBotAdm = await obterMetadadosGrupoComTimeout(remoteJid);
                const participantesBotAdm = Array.isArray(metaBotAdm?.participants) ? metaBotAdm.participants : [];
                const idsBotAdm = [sock?.user?.id, getBotJid()].filter(Boolean).map(normalizarJid);
                const participanteBotAdm = participantesBotAdm.find(p =>
                    [p?.id, p?.jid, p?.phoneNumber, p?.lid].filter(Boolean).map(normalizarJid).some(id => idsBotAdm.includes(id))
                );
                return participanteBotAdm?.admin === 'admin' || participanteBotAdm?.admin === 'superadmin';
            } catch (_) {
                return false;
            }
        }

        async function moderarMidiaAntiPorno(m, remoteJid, senderCanonico, cleanSender, souDonoFlag) {
            if (!remoteJid?.endsWith('@g.us') || m?.key?.fromMe || !dadosGlobais.antiPornoGrupos?.[remoteJid]) return false;
            const midia = obterMidiaDiretaAntiPorno(m.message);
            if (!midia) return false;

            let buffer;
            try {
                const stream = await downloadContentFromMessage(midia.msg, midia.type);
                buffer = await streamParaBufferLimitado(stream, 32 * 1024 * 1024, 'mídia do antiporno');
                const resultado = await classificarMidiaAntiPorno(buffer, midia.type, midia.msg.seconds || midia.msg.duration || 0);
                if (!resultado.explicito) return false;

                const metadata = await obterMetadadosGrupoComTimeout(remoteJid);
                const participantes = Array.isArray(metadata?.participants) ? metadata.participants : [];
                const idOriginal = m.key?.participant || senderCanonico;
                const idsAutor = [senderCanonico, idOriginal].filter(Boolean);
                const corresponde = (p, ids) => [p?.id, p?.jid, p?.phoneNumber, p?.lid].filter(Boolean).some(a =>
                    ids.some(b => a === b || normalizarJid(a) === normalizarJid(b))
                );
                const participanteAutor = participantes.find(p => corresponde(p, idsAutor));
                const ehAdminAutor = participanteAutor?.admin === 'admin' || participanteAutor?.admin === 'superadmin';
                // Nunca pune automaticamente administradores, o dono ou a própria conta do bot.
                if (souDonoFlag || ehAdminAutor || !participanteAutor) {
                    // Evento registrado apenas se houver erro real; sem log rotineiro de classificação.
                    return false;
                }

                const botJid = getBotJid() || sock.user?.id || '';
                const participanteBot = participantes.find(p => corresponde(p, [botJid].filter(Boolean)));
                if (!(participanteBot?.admin === 'admin' || participanteBot?.admin === 'superadmin')) {
                    console.warn(`[ANTIPORNO] Detectei conteúdo explícito em ${remoteJid}, mas o bot não é administrador; não consigo apagar/remover.`);
                    return false;
                }

                let apagou = false;
                try {
                    await sock.sendMessage(remoteJid, { delete: m.key });
                    apagou = true;
                } catch (erroApagar) {
                    console.warn('[ANTIPORNO] Não consegui apagar a mensagem:', erroApagar?.message || erroApagar);
                }

                const alvoJid = participanteAutor.id || participanteAutor.jid || participanteAutor.phoneNumber || idOriginal;
                let removeu = false;
                try {
                    await sock.groupParticipantsUpdate(remoteJid, [alvoJid], 'remove');
                    removeu = true;
                } catch (erroRemover) {
                    console.error('[ANTIPORNO] Não consegui remover o participante:', erroRemover?.message || erroRemover);
                }

                const mencaoJid = alvoJid;
                const numAlvo = normalizarJid(mencaoJid) || String(cleanSender || 'membro');
                if (removeu) {
                    await sock.sendMessage(remoteJid, {
                        text: `🛡️ *ANTIPORNO LOCAL*

🚫 @${numAlvo} foi removido automaticamente por mídia classificada como *${resultado.classe === 'Hentai' ? 'hentai' : 'pornográfica'}* (confiança ${(resultado.pontuacao * 100).toFixed(0)}%).
🗑️ Mensagem: ${apagou ? 'apagada' : 'não consegui apagar'}.`,
                        mentions: [mencaoJid]
                    }).catch(erro => console.warn('[ANTIPORNO] Não consegui enviar o aviso:', erro?.message || erro));
                } else {
                    await sock.sendMessage(remoteJid, {
                        text: `⚠️ *ANTIPORNO LOCAL:* detectei mídia possivelmente explícita de @${numAlvo} (confiança ${(resultado.pontuacao * 100).toFixed(0)}%) e ${apagou ? 'apaguei a mensagem' : 'tentei apagar a mensagem'}, mas não consegui remover o participante. Confira as permissões do bot.`,
                        mentions: [mencaoJid]
                    }).catch(() => {});
                }
                // Resultado da moderação não é despejado no terminal.
                // Impede que a mensagem moderada siga para XP/comandos/fluxos normais.
                return true;
            } catch (erro) {
                console.error('[ANTIPORNO] Falha na análise local; a mensagem não foi moderada:', erro?.message || erro);
                return false;
            }
        }

        async function publicarAvisoComProgressoNoGrupo(grupo, textoAvisoFinal) {
            let progresso = null;
            const textoProgresso = (percentual, etapa) => {
                const preenchidos = Math.round(Math.max(0, Math.min(100, percentual)) / 10);
                const barra = '█'.repeat(preenchidos) + '░'.repeat(10 - preenchidos);
                return `📢 *Aviso chegando*\n[${barra}] ${Math.max(0, Math.min(100, percentual))}%\n_${etapa}_`;
            };
            const textoFinal = `📢 *Resumos de Atualizações do bot*\n\n${textoAvisoFinal}\n\n_Logs sobre Atualizações._`;
            try {
                progresso = await sock.sendMessage(grupo.jid, { text: textoProgresso(0, 'Preparando aviso...') });
                if (!progresso?.key?.id) throw new Error('Não consegui obter a chave da mensagem de progresso.');
                marcarMensagemIgnorar(progresso.key.id, 60000);
                const chaveOriginal = progresso.key;
                await sock.sendMessage(grupo.jid, { text: textoProgresso(100, 'Concluído; publicando aviso...'), edit: chaveOriginal });
                await delay(120);
                await sock.sendMessage(grupo.jid, { text: textoFinal, edit: chaveOriginal });
                return { ok: true, editado: true };
            } catch (erroEdicaoAviso) {
                // Se a edição não for suportada pelo cliente/servidor, manda o aviso normal
                // para não perder o comunicado. Nunca repete o envio após uma edição concluída.
                try {
                    await sock.sendMessage(grupo.jid, { text: textoFinal });
                    return { ok: true, editado: false, erroEdicao: erroEdicaoAviso?.message || String(erroEdicaoAviso) };
                } catch (erroEnvioAviso) {
                    throw new Error(erroEnvioAviso?.message || erroEdicaoAviso?.message || 'Falha ao publicar aviso no grupo.');
                }
            }
        }

        async function processarRespostaAviso(remoteJid, m, messageText, avisoStateKey) {
            const estado = aguardandoAcaoAviso[avisoStateKey];
            if (!estado || !messageText) return false;

            const textoLimpo = String(messageText).trim().toLowerCase();
            if (!textoLimpo) return false;

            try {
                // Etapa 1: escolher entre enviar o aviso salvo ou alterar o texto.
                if (estado.etapa === 'escolher_aviso_salvo') {
                    if (['sim', 's', 'enviar'].includes(textoLimpo)) {
                        limparTimeoutAviso(avisoStateKey);

                        const grupos = await listarGruposComAvisos();

                        if (grupos.length === 0) {
                            delete aguardandoAcaoAviso[avisoStateKey];
                            return await sock.sendMessage(remoteJid, {
                                text: '✅ O aviso salvo está pronto, mas *nenhum grupo* está com avisos ativados no momento.\nUse `.avisoson` nos grupos desejados.'
                            }, { quoted: m }).then(() => true);
                        }

                        const listaNomes = grupos.map(g => `• ${g.nome}`).join('\n');

                        aguardandoAcaoAviso[avisoStateKey] = {
                            etapa: 'confirmar_enviar',
                            grupos
                        };
                        definirTimeoutAviso(avisoStateKey, remoteJid);

                        await enviarOpcoesAvisoTexto(remoteJid, `📢 *Grupos que receberão o aviso (${grupos.length}):*
${listaNomes}

❓ Deseja enviar o aviso agora para esses grupos?`, [ { id: 'sim', text: '🚀 Enviar aviso' }, { id: 'nao', text: 'Cancelar' }, { id: 'alterar', text: '✏ Alterar texto' } ], { quoted: m });

                        return true;
                    }

                    if (['cancelar', 'cancel', 'sair'].includes(textoLimpo)) {
                        limparTimeoutAviso(avisoStateKey);
                        delete aguardandoAcaoAviso[avisoStateKey];
                        await enviarEIgnorar(remoteJid, { text: '❌ Operação de aviso cancelada. O texto salvo foi mantido.' }, { quoted: m });
                        return true;
                    }

                    if (['alterar', 'mudar', 'nao', 'n', 'não'].includes(textoLimpo)) {
                        limparTimeoutAviso(avisoStateKey);
                        aguardandoAcaoAviso[avisoStateKey] = { etapa: 'texto_aviso' };
                        definirTimeoutAviso(avisoStateKey, remoteJid);

                        await enviarEIgnorar(remoteJid, {
                            text: '✏️ Mande o *novo texto* do aviso (você tem 30s):'
                        }, { quoted: m });

                        return true;
                    }

                    await enviarOpcoesAvisoTexto(remoteJid,
                        '❓ Escolha o que fazer com o aviso salvo.',
                        [ { id: 'enviar', text: '📢 Enviar salvo' }, { id: 'alterar', text: '✏ Alterar texto' }, { id: 'cancelar', text: 'Cancelar' } ],
                        { quoted: m });
                    return true;
                }

                // A etapa de texto também pode ser cancelada sem salvar a palavra 'cancelar'.
                if (estado.etapa === 'texto_aviso' && ['cancelar', 'cancel'].includes(textoLimpo)) {
                    limparTimeoutAviso(avisoStateKey);
                    delete aguardandoAcaoAviso[avisoStateKey];
                    await enviarEIgnorar(remoteJid, { text: '❌ Cadastro/alteração do aviso cancelado. O texto salvo anteriormente foi mantido.' }, { quoted: m });
                    return true;
                }

                // Etapa 2: receber o novo texto. Qualquer mensagem de texto serve.
                if (estado.etapa === 'texto_aviso') {
                    const novoTexto = String(messageText).trim();

                    if (!novoTexto) {
                        await enviarEIgnorar(remoteJid, {
                            text: '❌ O texto do aviso não pode ficar vazio. Mande o novo texto novamente.'
                        }, { quoted: m });
                        return true;
                    }

                    let barraRecebendoAvisos = null;
                    try {
                        barraRecebendoAvisos = await criarBarraProgressoWhatsApp(remoteJid, m, 'Recebendo avisos', 'aviso');
                        await barraRecebendoAvisos.atualizar(25, 'Texto recebido; salvando o aviso...', true);
                    } catch (erroBarraAviso) {
                        console.warn('[AVISO] Não consegui exibir o carregamento; vou continuar normalmente:', erroBarraAviso?.message || erroBarraAviso);
                    }

                    limparTimeoutAviso(avisoStateKey);
                    dadosGlobais.textoAviso = novoTexto;
                    await salvarDadosBot(dadosGlobais);
                    await barraRecebendoAvisos?.atualizar(55, 'Aviso salvo; procurando grupos com avisos ativados...', true).catch(() => {});

                    const grupos = await listarGruposComAvisos();

                    if (grupos.length === 0) {
                        delete aguardandoAcaoAviso[avisoStateKey];
                        const textoFinalSemGrupos = '✅ Texto do aviso *salvo* com sucesso!\n\n⚠️ Porém *nenhum grupo* está com avisos ativados no momento.\nUse `.avisoson` nos grupos desejados.';
                        const substituida = await barraRecebendoAvisos?.substituir({ text: textoFinalSemGrupos }).catch(() => null);
                        if (!substituida) await sock.sendMessage(remoteJid, { text: textoFinalSemGrupos }, { quoted: m });
                        return true;
                    }

                    const listaNomes = grupos.map(g => `• ${g.nome}`).join('\n');

                    aguardandoAcaoAviso[avisoStateKey] = {
                        etapa: 'confirmar_enviar',
                        grupos
                    };
                    definirTimeoutAviso(avisoStateKey, remoteJid);
                    await barraRecebendoAvisos?.finalizar('Aviso recebido e salvo; confira a confirmação abaixo.').catch(() => {});

                    await enviarOpcoesAvisoTexto(remoteJid, `✅ Texto do aviso *salvo*!

📢 *Grupos que receberão o aviso (${grupos.length}):*
${listaNomes}

❓ Deseja enviar o aviso agora para esses grupos?`, [ { id: 'sim', text: '🚀 Enviar aviso' }, { id: 'nao', text: 'Cancelar' }, { id: 'alterar', text: '✏ Alterar texto' } ], { quoted: m });

                    return true;
                }

                // Etapa 3: confirmar o envio.
                if (estado.etapa === 'confirmar_enviar') {
                    // Evita despejar o conteúdo de conversas no terminal.

                    if (['sim', 's', 'enviar'].includes(textoLimpo)) {
                        if (!Array.isArray(estado.grupos) || estado.grupos.length === 0) {
                            limparTimeoutAviso(avisoStateKey);
                            delete aguardandoAcaoAviso[avisoStateKey];

                            await sock.sendMessage(remoteJid, {
                                text: '❌ Não encontrei os grupos deste envio. Execute `.aviso` novamente.'
                            }, { quoted: m });

                            return true;
                        }

                        limparTimeoutAviso(avisoStateKey);
                        delete aguardandoAcaoAviso[avisoStateKey];

                        const grupos = estado.grupos;
                        const textoFinal = String(dadosGlobais.textoAviso || '').trim();

                        if (!textoFinal) {
                            await sock.sendMessage(remoteJid, {
                                text: '❌ O texto do aviso está vazio. Execute `.aviso` novamente para cadastrar um texto.'
                            }, { quoted: m });
                            return true;
                        }

                        let barraEnvioAvisos = null;
                        try {
                            barraEnvioAvisos = await criarBarraProgressoWhatsApp(remoteJid, m, 'Enviando avisos', 'aviso');
                            await barraEnvioAvisos.atualizar(5, `Preparando envio para ${grupos.length} grupo(s)...`, true);
                        } catch (erroBarraEnvioAvisos) {
                            console.warn('[AVISO] Não consegui exibir o progresso do disparo:', erroBarraEnvioAvisos?.message || erroBarraEnvioAvisos);
                            await sock.sendMessage(remoteJid, { text: `🚀 Enviando aviso para *${grupos.length}* grupo(s)...` }, { quoted: m });
                        }

                        let enviados = 0;
                        let falhas = 0;
                        let processadosAvisos = 0;

                        for (const grupo of grupos) {
                            try {
                                const envioComProgresso = publicarAvisoComProgressoNoGrupo(grupo, textoFinal);
                                let timerLimiteAviso;
                                const limite = new Promise((_, reject) => {
                                    timerLimiteAviso = setTimeout(() => reject(new Error('timeout ao enviar aviso')), 20000);
                                });
                                try {
                                    await Promise.race([envioComProgresso, limite]);
                                } finally {
                                    clearTimeout(timerLimiteAviso);
                                }
                                enviados++;
                                await delay(180);
                            } catch (err) {
                                falhas++;
                                console.error(`[AVISO] Erro ao enviar para ${grupo.nome}:`, err?.message || err);
                            } finally {
                                processadosAvisos++;
                                const percentualEnvio = 5 + Math.floor((processadosAvisos / grupos.length) * 90);
                                await barraEnvioAvisos?.atualizar(percentualEnvio, `Processados ${processadosAvisos}/${grupos.length} grupos...`, true).catch(() => {});
                            }
                        }

                        const textoResumoAvisos = `✅ Aviso enviado!\n\n• Sucesso: *${enviados}*\n• Falhas: *${falhas}*`;
                        const resumoSubstituido = await barraEnvioAvisos?.substituir({ text: textoResumoAvisos }).catch(() => null);
                        if (!resumoSubstituido) await sock.sendMessage(remoteJid, { text: textoResumoAvisos }, { quoted: m });

                        return true;
                    }

                    if (['nao', 'n', 'não', 'cancelar', 'cancel'].includes(textoLimpo)) {
                        limparTimeoutAviso(avisoStateKey);
                        delete aguardandoAcaoAviso[avisoStateKey];

                        await sock.sendMessage(remoteJid, {
                            text: '❌ Envio de aviso cancelado. O texto continua salvo.'
                        }, { quoted: m });

                        return true;
                    }

                    if (['alterar', 'mudar'].includes(textoLimpo)) {
                        limparTimeoutAviso(avisoStateKey);
                        aguardandoAcaoAviso[avisoStateKey] = { etapa: 'texto_aviso' };
                        definirTimeoutAviso(avisoStateKey, remoteJid);

                        await enviarEIgnorar(remoteJid, {
                            text: '✏️ Mande o *novo texto* do aviso (você tem 30s):'
                        }, { quoted: m });

                        return true;
                    }

                    await enviarOpcoesAvisoTexto(remoteJid, '❓ Deseja enviar o aviso, cancelar ou alterar o texto?', [ { id: 'sim', text: '🚀 Enviar' }, { id: 'nao', text: 'Cancelar' }, { id: 'alterar', text: '✏ Alterar' } ], { quoted: m });

                    return true;
                }

                return false;
            } catch (erroAviso) {
                console.error('[AVISO] Erro no fluxo interativo:', erroAviso);
                limparTimeoutAviso(avisoStateKey);
                delete aguardandoAcaoAviso[avisoStateKey];

                try {
                    await sock.sendMessage(remoteJid, {
                        text: `❌ Ocorreu um erro no processo de aviso.\n\n${erroAviso?.message || 'Erro desconhecido'}\n\nExecute \`.aviso\` novamente.`
                    }, { quoted: m });
                } catch {}

                return true;
            }
        }

        // O histórico/offline sync pode conter mídia ou mensagens que demoram a
        // processar. Uma fila única em série fazia essas mensagens bloquearem os
        // comandos seguintes até eles ficarem antigos demais. Mantemos concorrência
        // limitada e uma fila prioritária de comandos de texto.
        const filaComandosMensagens = [];
        const filaNormalMensagens = [];
        let mensagensEmProcessamento = 0;
        let mensagensNormaisEmProcessamento = 0;
        let conversoesPesadasAtivas = 0;
        const LIMITE_PROCESSAMENTO_MENSAGENS = 6;
        // No máximo quatro mensagens comuns ocupam workers; os outros dois ficam
        // disponíveis para comandos quando houver fila, reduzindo a espera.
        const LIMITE_PROCESSAMENTO_NORMAL_MENSAGENS = 4;
        // O telefone tem 4 GB de RAM: limita trabalhos pesados simultâneos, mantendo
        // comandos leves livres para responder enquanto vídeos/áudios são convertidos.
        const LIMITE_CONVERSOES_PESADAS = 2;
        const LIMITE_FILA_NORMAL_MENSAGENS = 2000;
        const LIMITE_FILA_COMANDOS_MENSAGENS = 1000;
        const COMANDOS_CONVERSAO_PESADA = new Set([
            'f', 's', 'achatar', 'toimg', 'tovideo', 'toaudio', 'estourar',
            'link', 'yt', 'youtube', 'sim', 'totag'
        ]);

        function ehConversaoPesadaMensagem(mensagem) {
            const jid = mensagem?.key?.remoteJid;
            const prefixo = obterPrefixoChat(jid);
            const texto = obterTextoMensagem(mensagem?.message).trim();
            if (!texto.startsWith(prefixo)) return false;
            const comando = texto.slice(prefixo.length).trim().split(/\s+/)[0]
                .normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').toLowerCase();
            return COMANDOS_CONVERSAO_PESADA.has(comando) || comando.startsWith('gif');
        }

        function contarConversoesNaFila() {
            let total = 0;
            for (const item of filaComandosMensagens) if (ehConversaoPesadaMensagem(item.mensagem)) total++;
            for (const item of filaNormalMensagens) if (ehConversaoPesadaMensagem(item.mensagem)) total++;
            return total;
        }

        function retirarProximaMensagemElegivel() {
            const podeIniciarPesada = conversoesPesadasAtivas < LIMITE_CONVERSOES_PESADAS;
            const encontrar = (fila) => fila.findIndex(item => !ehConversaoPesadaMensagem(item.mensagem) || podeIniciarPesada);
            let indice = encontrar(filaComandosMensagens);
            if (indice >= 0) return { item: filaComandosMensagens.splice(indice, 1)[0], fila: 'comando' };
            if (mensagensNormaisEmProcessamento >= LIMITE_PROCESSAMENTO_NORMAL_MENSAGENS) return null;
            indice = encontrar(filaNormalMensagens);
            if (indice >= 0) return { item: filaNormalMensagens.splice(indice, 1)[0], fila: 'normal' };
            return null;
        }

        function drenarFilaMensagens() {
            while (sockAtual === sock && mensagensEmProcessamento < LIMITE_PROCESSAMENTO_MENSAGENS) {
                const proximo = retirarProximaMensagemElegivel();
                if (!proximo) return;
                const { item } = proximo;
                const conversaoPesada = ehConversaoPesadaMensagem(item.mensagem);
                mensagensEmProcessamento++;
                if (proximo.fila === 'normal') mensagensNormaisEmProcessamento++;
                if (conversaoPesada) conversoesPesadasAtivas++;
                Promise.resolve()
                    .then(() => processarMensagemRecebida(item.mensagem, item.recebidaEm, item.tipo))
                    .catch(erroMensagem => {
                        console.error('[MENSAGENS] Falha ao processar uma mensagem; continuando:', erroMensagem?.stack || erroMensagem?.message || erroMensagem);
                    })
                    .finally(() => {
                        mensagensEmProcessamento = Math.max(0, mensagensEmProcessamento - 1);
                        if (proximo.fila === 'normal') mensagensNormaisEmProcessamento = Math.max(0, mensagensNormaisEmProcessamento - 1);
                        if (conversaoPesada) conversoesPesadasAtivas = Math.max(0, conversoesPesadasAtivas - 1);
                        drenarFilaMensagens();
                    });
            }
        }

        sock.ev.on('messages.upsert', ({ messages, type }) => {
            // Ignora eventos atrasados de um socket já substituído.
            if (sockAtual !== sock || socketsEncerrados.has(sock)) return;
            if (!Array.isArray(messages) || messages.length === 0) return;
            if (type !== 'notify' && type !== 'append') return;

            const recebidaEm = Date.now();
            let comandosAdicionados = 0;
            let descartadasAntigas = 0;

            for (const mensagem of messages) {
                if (!mensagem?.message) continue;
                const timestamp = Number(mensagem.messageTimestamp) || 0;
                const idadeSegundos = timestamp > 0
                    ? Math.floor(recebidaEm / 1000) - timestamp
                    : null;

                const texto = obterTextoMensagem(mensagem.message).trim();
                const prefixoMensagem = obterPrefixoChat(mensagem.key?.remoteJid);
                const ehComando = texto.startsWith(prefixoMensagem);

                // 'notify' é o evento de mensagem recebida ao vivo. Não o rejeitamos
                // pelo timestamp: atrasos/relógios desalinhados não devem descartar comandos novos.
                // 'append' pode trazer uma mensagem recente recuperada durante a reconexão.
                // Reproduzimos apenas comandos com timestamp conhecido e recente (até 120 s),
                // com tolerância de 30 s para pequenas diferenças de relógio. Mensagens antigas
                // ficam de fora para evitar executar de novo comandos do histórico.
                if (type === 'append' && ehComando) {
                    if (idadeSegundos === null || idadeSegundos > 120 || idadeSegundos < -30) {
                        descartadasAntigas++;
                        continue;
                    }
                } else if (type === 'append' && idadeSegundos !== null && idadeSegundos > 120) {
                    descartadasAntigas++;
                    continue;
                }

                const item = { mensagem, recebidaEm, tipo: type };
                if (ehComando) {
                    if (filaComandosMensagens.length >= LIMITE_FILA_COMANDOS_MENSAGENS) {
                        filaComandosMensagens.shift();
                        console.error('[MENSAGENS] ⚠️ A fila prioritária atingiu o limite; descartei o comando mais antigo para proteger a memória.');
                    }
                    filaComandosMensagens.push(item);
                    comandosAdicionados++;
                    if (type === 'append') {
                        console.log(`[MENSAGENS] Comando recente recuperado após reconexão; será processado uma vez (idade aprox.: ${idadeSegundos}s).`);
                    }
                    // A deduplicação por ID ocorre em processarMensagemRecebida antes de executar.
                } else {
                    if (filaNormalMensagens.length >= LIMITE_FILA_NORMAL_MENSAGENS) {
                        filaNormalMensagens.shift();
                    }
                    filaNormalMensagens.push(item);
                }
            }

            if (descartadasAntigas > 0) {
                // Mensagens antigas descartadas silenciosamente.
            }
            if (comandosAdicionados > 0 || messages.length > 1) {
                // Estatísticas de lote omitidas do log normal.
            }
            drenarFilaMensagens();
        });

        async function processarMensagemRecebida(m, recebidoEm = Date.now(), tipoEvento = 'notify') {
            if (!m?.message) {
                return;
            }

            if (m.key?.fromMe && mensagensIgnorarInterativo.has(m.key.id)) {
                const expiraIgnorar = mensagensIgnorarInterativo.get(m.key.id);
                mensagensIgnorarInterativo.delete(m.key.id);
                if (expiraIgnorar > Date.now()) return;
            }

            const msgTimestamp = Number(m.messageTimestamp) || 0;
            const instanteRecebimento = Number(recebidoEm) || Date.now();
            const agoraTs = Math.floor(instanteRecebimento / 1000);
            // O timestamp só é usado para bloquear histórico append. Um notify
            // representa mensagem ao vivo e deve chegar ao parser de comandos mesmo
            // se o horário do dispositivo/servidor estiver desalinhado.
            if (tipoEvento === 'append' && msgTimestamp > 0 && agoraTs - msgTimestamp > 120) {
                return;
            }

            if (mensagemJaProcessada(m)) {
                return;
            }

            const remoteJid = m.key?.remoteJid;
            if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter') || remoteJid.endsWith('@broadcast')) return;
            const prefix = obterPrefixoChat(remoteJid);

            try {
                const isGroup = remoteJid.endsWith('@g.us');
                
                let sender = m.key.participant || m.key.remoteJid;
                if (m.key.fromMe) sender = getBotJid() || sender;

                let senderCanonico = sender;
                if (isGroup && !m.key.fromMe) {
                    senderCanonico = await resolverJidCanonicoGrupo(remoteJid, sender);
                    if (senderCanonico !== sender) {
                        await migrarDadosIdentidadeGrupo(remoteJid, sender, senderCanonico);
                    }
                }

                const souDono = await eDono(m, senderCanonico, dadosGlobais.numeroDono, sock);
                const cleanSender = normalizarJid(senderCanonico);
                const userGroupKey = `${remoteJid}_${cleanSender}`;
                const stateKey = chaveEstadoChat(sender, remoteJid);

                // Controle de aluguel por grupo. Os comandos .pg/.npg/.gc são tratados
                // antes de qualquer fluxo pendente e nunca geram resposta no WhatsApp.
                // Grupo sem status ou marcado como npg permanece totalmente silencioso.
                if (isGroup) {
                    const textoAluguel = obterTextoMensagem(m.message).trim();
                    const prefixoAluguel = obterPrefixoChat(remoteJid);
                    const comandosAluguel = new Map([[`${prefixoAluguel}pg`, 'pg'], [`${prefixoAluguel}npg`, 'npg'], [`${prefixoAluguel}gc`, 'gc']]);
                    const comandoAluguel = comandosAluguel.get(textoAluguel.toLowerCase()) || '';
                    if (souDono && comandoAluguel) {
                        if (!dadosGlobais.statusAluguelGrupos || typeof dadosGlobais.statusAluguelGrupos !== 'object') {
                            dadosGlobais.statusAluguelGrupos = {};
                        }
                        dadosGlobais.statusAluguelGrupos[remoteJid] = comandoAluguel;
                        limparAutorizacaoPendenteGrupo(remoteJid);
                        await salvarDadosBot(dadosGlobais);
                        registrarLogComandoTerminal({
                            m,
                            cleanSender,
                            remoteJid,
                            prefix: prefixoAluguel,
                            command: comandoAluguel,
                            statusLabel: ROTULOS_STATUS_ALUGUEL_TERMINAL[comandoAluguel]
                        });
                        return;
                    }
                    const statusAluguel = dadosGlobais.statusAluguelGrupos?.[remoteJid];
                    if (statusAluguel !== 'pg' && statusAluguel !== 'gc') {
                        // Só responde aos comandos num grupo recém-adicionado que esteja aguardando decisão do dono.
                        // Grupos preexistentes sem cadastro/status (por exemplo, grupos escolares) ficam totalmente ignorados.
                        if (dadosGlobais.gruposAguardandoAutorizacao?.[remoteJid] && prefixoAluguel && textoAluguel.startsWith(prefixoAluguel)) {
                            await avisarGrupoBloqueado(remoteJid, statusAluguel, { quoted: m });
                        }
                        return;
                    }
                }

                // Chave estável do fluxo de avisos: evita perder o estado quando o WhatsApp alterna entre JID/LID.
                // O fluxo de avisos é exclusivo do dono e pertence à conversa atual.
// Usar o remoteJid evita que mudanças entre JID/LID façam o estado desaparecer.
const avisoStateKey = remoteJid;

                const viewOnceMsgObj = encontrarMensagemViewOnce(m.message);
                const isViewOnceMsg = !!viewOnceMsgObj;

                if (isViewOnceMsg && viewOnceMsgObj) {
                    const mediaInfoVisu = getMediaMessage(viewOnceMsgObj);

                    if (mediaInfoVisu && (mediaInfoVisu.type === 'image' || mediaInfoVisu.type === 'video')) {
                        const downloadType = mediaInfoVisu.type;
                        const mediaObj = mediaInfoVisu.msg;

                        try {
                            const stream = await downloadContentFromMessage(mediaObj, downloadType);
                            const buffer = await streamParaBufferLimitado(stream, 32 * 1024 * 1024, 'mídia de visualização única');

                            const legendaOriginal = mediaObj.caption || '';
                            guardarBufferVisu(m.key.id, {
                                buffer,
                                type: downloadType,
                                caption: legendaOriginal,
                                mimetype: mediaObj.mimetype || null
                            });

                            if (!m.key.fromMe) {
                                const numDonoLimpo = String(dadosGlobais.numeroDono || '').replace(/\D/g, '');
                                if (numDonoLimpo) {
                                    const donoJid = `${numDonoLimpo}@s.whatsapp.net`;
                                    const remetenteJid = m.key.participant || m.key.remoteJid;
                                    const numRemetente = remetenteJid.split('@')[0];

                                    let localOrigem = 'Privado';
                                    if (remoteJid.endsWith('@g.us')) {
                                        try {
                                            const meta = await obterMetadadosGrupoComTimeout(remoteJid);
                                            localOrigem = `Grupo *${meta.subject}*`;
                                        } catch {
                                            localOrigem = `Grupo (${remoteJid.split('@')[0]})`;
                                        }
                                    }

                                    const legendaVisu = `👁️ *MÍDIA DE VISUALIZAÇÃO ÚNICA CAPTURADA!*\n\n` +
                                                        `👤 *Enviado por:* @${numRemetente}\n` +
                                                        `📍 *Local:* ${localOrigem}\n\n` +
                                                        (legendaOriginal
                                                            ? `💬 *Legenda original:* ${legendaOriginal}`
                                                            : `💬 *Legenda:* (Sem legenda)`);

                                    if (downloadType === 'image') {
                                        await sock.sendMessage(donoJid, {
                                            image: buffer,
                                            caption: legendaVisu,
                                            mentions: [remetenteJid]
                                        });
                                    } else {
                                        await sock.sendMessage(donoJid, {
                                            video: buffer,
                                            caption: legendaVisu,
                                            mentions: [remetenteJid]
                                        });
                                    }
                                }
                            }
                        } catch (e) {
                            console.error('❌ Erro ao baixar visu única preventivamente:', e);
                        }
                    }
                }

                if (await moderarMidiaAntiPorno(m, remoteJid, senderCanonico, cleanSender, souDono)) {
                    return;
                }

                const protocoloRaiz = desempacotarMensagem(m.message);
                const protocolMsg = protocoloRaiz?.protocolMessage ||
                                    m.message?.protocolMessage ||
                                    m.message?.ephemeralMessage?.message?.protocolMessage;

                if (protocolMsg && (protocolMsg.type === 0 || protocolMsg.type === 'REVOKE')) { 
                    const idOriginal = protocolMsg.key?.id;

                    const registroMensagemCache = idOriginal ? cacheMensagens.get(idOriginal) : null;
                    if (registroMensagemCache && registroMensagemCache.expiraEm > Date.now()) {
                        const msgSalva = registroMensagemCache.mensagem;
                        cacheMensagens.delete(idOriginal);

                        const numDonoLimpo = String(dadosGlobais.numeroDono || '').replace(/\D/g, '');
                        if (!numDonoLimpo) return;
                        const donoJid = `${numDonoLimpo}@s.whatsapp.net`;

                        let autorOriginalJid = msgSalva.key.participant || msgSalva.key.remoteJid;
                        if (msgSalva.key.fromMe) autorOriginalJid = getBotJid();
                        
                        let quemApagouJid = m.key.participant || m.key.remoteJid;
                        if (m.key.fromMe) quemApagouJid = getBotJid();

                        const numAutor = autorOriginalJid.split('@')[0];
                        const numApagou = quemApagouJid.split('@')[0];

                        let localOrigem = 'Privado';
                        if (msgSalva.key.remoteJid.endsWith('@g.us')) {
                            try {
                                const meta = await obterMetadadosGrupoComTimeout(msgSalva.key.remoteJid);
                                localOrigem = `Grupo *${meta.subject}*`;
                            } catch {
                                localOrigem = `Grupo (${msgSalva.key.remoteJid.split('@')[0]})`;
                            }
                        }

                        const corpoMsg = msgSalva.message;
                        const mediaInfo = getTargetMedia(corpoMsg);
                        
                        const foiVisuUnica = checkIsViewOnce(msgSalva.message);
                        const statusVisu = foiVisuUnica ? "Sim 👁️" : "Não ❌";

                        const cabecalho = `⚠️ *MENSAGEM APAGADA DETECTADA!*\n\n` +
                                          `🗑 *Apagada por:* @${numApagou}\n` +
                                          `👤 *Autor da msg:* @${numAutor}\n` +
                                          `📍 *Local:* ${localOrigem}\n` +
                                          `👁️ *Visu Única:* ${statusVisu}\n\n`;

                        const mentionsArray = [autorOriginalJid, quemApagouJid];

                        try {
                            if (mediaInfo) {
                                let buffer = Buffer.from([]);

                                let legendaOriginal = mediaInfo.msg.caption || '';

                                const cacheVisu = cacheBuffersVisu.get(idOriginal);
                                if (cacheVisu?.buffer && cacheVisu.expiraEm > Date.now()) {
                                    buffer = cacheVisu.buffer;
                                    if (cacheVisu.caption) legendaOriginal = cacheVisu.caption;
                                } else {
                                    if (cacheVisu) cacheBuffersVisu.delete(idOriginal);
                                    const stream = await downloadContentFromMessage(mediaInfo.msg, mediaInfo.type);
                                    buffer = await streamParaBufferLimitado(stream, LIMITE_BUFFER_MIDIA_BYTES, 'mídia restaurada');
                                }

                                const legendaFinal = cabecalho +
                                    (legendaOriginal ? `💬 *Legenda original:* ${legendaOriginal}` : '');

                                if (mediaInfo.type === 'image') {
                                    await sock.sendMessage(donoJid, { image: buffer, caption: legendaFinal, mentions: mentionsArray });
                                } else if (mediaInfo.type === 'video') {
                                    await sock.sendMessage(donoJid, { video: buffer, caption: legendaFinal, mentions: mentionsArray });
                                } else if (mediaInfo.type === 'audio') {
                                    await sock.sendMessage(donoJid, { text: cabecalho, mentions: mentionsArray });
                                    await sock.sendMessage(donoJid, { audio: buffer, mimetype: 'audio/mp4', ptt: mediaInfo.msg.ptt || false });
                                } else if (mediaInfo.type === 'sticker') {
                                    await sock.sendMessage(donoJid, { text: cabecalho, mentions: mentionsArray });
                                    await sock.sendMessage(donoJid, { sticker: buffer });
                                } else if (mediaInfo.type === 'document') {
                                    await sock.sendMessage(donoJid, { text: cabecalho, mentions: mentionsArray });
                                    await sock.sendMessage(donoJid, { document: buffer, mimetype: mediaInfo.msg.mimetype, fileName: mediaInfo.msg.fileName || 'arquivo' });
                                }
                            } else {
                                let msgTextoRoot = msgSalva.message?.ephemeralMessage?.message || msgSalva.message;
                                msgTextoRoot = msgTextoRoot?.viewOnceMessage?.message || msgTextoRoot?.viewOnceMessageV2?.message || msgTextoRoot?.viewOnceMessageV2Extension?.message || msgTextoRoot;
                                
                                const textoMensagem = msgTextoRoot?.conversation || 
                                                     msgTextoRoot?.extendedTextMessage?.text || 
                                                     'Conteúdo não identificado ou mídia sem legenda.';

                                await sock.sendMessage(donoJid, {
                                    text: cabecalho + `💬 *Conteúdo apagado:*\n${textoMensagem}`,
                                    mentions: mentionsArray
                                });
                            }
                        } catch (e) {
                            console.error('Erro ao restaurar mídia apagada:', e);
                            await sock.sendMessage(donoJid, {
                                text: cabecalho + `❌ *Não foi possível carregar a mídia apagada.*`,
                                mentions: mentionsArray
                            });
                        }
                    }
                    return;
                }

                if (m.key.id) guardarMensagemCache(m);

                if (isGroup && dadosGlobais.usuariosMutados[userGroupKey] && !souDono) {
                    const statusMute = dadosGlobais.usuariosMutados[userGroupKey];
                    const agoraMute = Date.now();

                    if (statusMute === 'permanente' || agoraMute < statusMute) {
                        try {
                            await sock.sendMessage(remoteJid, { delete: m.key });
                        } catch (err) {}
                        return;
                    } else {
                        delete dadosGlobais.usuariosMutados[userGroupKey];
                        await salvarDadosBot(dadosGlobais);
                    }
                }

                if (isGroup && gruposAntiSpamAtivo.has(remoteJid) && !souDono) {
                    const agoraSpam = Date.now();

                    if (!historicoMensagens[userGroupKey]) {
                        // Não mantém indefinidamente uma chave por pessoa que já passou pelo grupo.
                        if (Object.keys(historicoMensagens).length >= 2000) {
                            for (const [chaveHistorico, tempos] of Object.entries(historicoMensagens)) {
                                if (!tempos?.length || agoraSpam - tempos[tempos.length - 1] >= 4000) delete historicoMensagens[chaveHistorico];
                            }
                            while (Object.keys(historicoMensagens).length >= 2000) {
                                delete historicoMensagens[Object.keys(historicoMensagens)[0]];
                            }
                        }
                        historicoMensagens[userGroupKey] = [];
                    }

                    historicoMensagens[userGroupKey].push(agoraSpam);
                    historicoMensagens[userGroupKey] = historicoMensagens[userGroupKey].filter(
                        tempo => agoraSpam - tempo < 4000
                    );

                    if (historicoMensagens[userGroupKey].length >= 4) {
                        dadosGlobais.usuariosMutados[userGroupKey] = agoraSpam + 20000;
                        await salvarDadosBot(dadosGlobais);
                        
                        historicoMensagens[userGroupKey] = [];

                        try {
                            await sock.sendMessage(remoteJid, { delete: m.key });
                        } catch (err) {}

                        await sock.sendMessage(remoteJid, {
                            text: `🚫 *@${cleanSender}*, você foi silenciado por *20 segundos* por spam!`,
                            mentions: [sender]
                        });

                        return;
                    }
                }

                const corpoMsg = m.message.ephemeralMessage?.message || m.message;
                const messageText = obterTextoMensagem(corpoMsg);

                // Respostas aos botões PG/GC/NPG chegam como IDs próprios no privado do dono.
                const escolhaGrupo = String(messageText || '').trim().match(/^ARLEY_GRUPO\|(pg|gc|npg|aguardar)\|(.+)$/i);
                if (escolhaGrupo) {
                    if (!souDono || isGroup) return;
                    const statusEscolhido = escolhaGrupo[1].toLowerCase();
                    const grupoEscolhido = escolhaGrupo[2];
                    const pedidoExistente = dadosGlobais.gruposAguardandoAutorizacao?.[grupoEscolhido];
                    if (!pedidoExistente) {
                        return await sock.sendMessage(remoteJid, { text: 'ℹ️ Essa solicitação já expirou ou foi resolvida. Se o bot ainda estiver no grupo, adicione-o novamente para gerar um novo pedido.' }, { quoted: m });
                    }
                    if (!dadosGlobais.statusAluguelGrupos || typeof dadosGlobais.statusAluguelGrupos !== 'object') dadosGlobais.statusAluguelGrupos = {};

                    if (statusEscolhido === 'aguardar') {
                        const statusJaDefinido = String(dadosGlobais.statusAluguelGrupos?.[grupoEscolhido] || '').toLowerCase();
                        if (['pg', 'gc'].includes(statusJaDefinido)) {
                            limparAutorizacaoPendenteGrupo(grupoEscolhido);
                            await salvarDadosBot(dadosGlobais).catch(() => {});
                            return await sock.sendMessage(remoteJid, { text: `ℹ️ O grupo já está configurado como *${statusJaDefinido.toUpperCase()}*. Nenhuma alteração foi feita.` }, { quoted: m });
                        }
                        if (statusJaDefinido === 'npg') {
                            return await sock.sendMessage(remoteJid, { text: '🚫 Este grupo já está marcado como NPG. O ArleyBot manterá a tentativa de saída.' }, { quoted: m });
                        }
                        // Não escolhe PG/GC/NPG: deixa o grupo sem classificação e reinicia
                        // o prazo completo de 60 segundos a partir do clique do dono.
                        const timerExistente = temporizadoresAutorizacaoGrupo.get(grupoEscolhido);
                        if (timerExistente?.timer) clearTimeout(timerExistente.timer);
                        temporizadoresAutorizacaoGrupo.delete(grupoEscolhido);
                        pedidoExistente.expiraEm = Date.now() + PRAZO_AUTORIZACAO_GRUPO_MS;
                        pedidoExistente.avisoDonoEnviado = true;
                        pedidoExistente.saidaPendente = false;
                        await salvarDadosBot(dadosGlobais);
                        iniciarPrazoAutorizacaoGrupo(grupoEscolhido);
                        return await sock.sendMessage(remoteJid, {
                            text: `⏳ Certo. O grupo *${pedidoExistente?.nome || grupoEscolhido}* continuará sem configuração. O ArleyBot sairá automaticamente em 1 minuto, salvo se você escolher PG ou GC antes disso.`
                        }, { quoted: m });
                    }

                    dadosGlobais.statusAluguelGrupos[grupoEscolhido] = statusEscolhido;
                    if (statusEscolhido === 'npg') {
                        const timerExistente = temporizadoresAutorizacaoGrupo.get(grupoEscolhido);
                        if (timerExistente?.timer) clearTimeout(timerExistente.timer);
                        temporizadoresAutorizacaoGrupo.delete(grupoEscolhido);
                        if (!dadosGlobais.gruposAguardandoAutorizacao) dadosGlobais.gruposAguardandoAutorizacao = {};
                        dadosGlobais.gruposAguardandoAutorizacao[grupoEscolhido] = {
                            ...(pedidoExistente || {}),
                            criadoEm: pedidoExistente?.criadoEm || Date.now(),
                            expiraEm: Date.now(),
                            avisoDonoEnviado: true,
                            motivoSaida: 'npg',
                            saidaPendente: true,
                            nome: pedidoExistente?.nome || grupoEscolhido
                        };
                        await salvarDadosBot(dadosGlobais);
                        await tentarSairGrupoSemConfiguracao(grupoEscolhido);
                        return await sock.sendMessage(remoteJid, {
                            text: `✅ Grupo *${pedidoExistente?.nome || grupoEscolhido}* marcado como *NPG — Não Pago/Bloqueado*. Solicitei a saída do ArleyBot; se a conexão estiver indisponível, ele tentará novamente automaticamente.`
                        }, { quoted: m });
                    }

                    limparAutorizacaoPendenteGrupo(grupoEscolhido);
                    await salvarDadosBot(dadosGlobais);
                    const rotuloEscolhido = statusEscolhido === 'pg' ? 'PG — Pago' : 'GC — Gratuito';
                    try { await sock.sendMessage(grupoEscolhido, { text: `✅ *ArleyBot configurado!* Este grupo foi autorizado como *${rotuloEscolhido}*.` }); } catch (_) {}
                    return await sock.sendMessage(remoteJid, { text: `✅ Grupo *${pedidoExistente?.nome || grupoEscolhido}* configurado como *${rotuloEscolhido}*. O bot permanecerá no grupo.` }, { quoted: m });
                }

                const selecaoAddAtual = aguardandoSelecaoAdd[userGroupKey];
                if (selecaoAddAtual && (!selecaoAddAtual.expiraEm || selecaoAddAtual.expiraEm <= Date.now())) {
                    delete aguardandoSelecaoAdd[userGroupKey];
                }
                if (isGroup && aguardandoSelecaoAdd[userGroupKey] && messageText) {
                    const textoLimpo = messageText.trim();
                    const opcao = parseInt(textoLimpo, 10);
                    const lista = aguardandoSelecaoAdd[userGroupKey].lista;

                    if (!isNaN(opcao) && opcao >= 1 && opcao <= lista.length) {
                        const jidParaAdicionar = lista[opcao - 1];
                        delete aguardandoSelecaoAdd[userGroupKey];

                        try {
                            await sock.groupParticipantsUpdate(remoteJid, [jidParaAdicionar], 'add');
                            const numClean = jidParaAdicionar.split('@')[0];
                            return await sock.sendMessage(remoteJid, {
                                text: `✅ *@${numClean}* adicionado(a) com sucesso!`,
                                mentions: [jidParaAdicionar]
                            }, { quoted: m });
                        } catch (err) {
                            console.error('Erro ao readicionar participante:', err);
                            return await sock.sendMessage(remoteJid, { text: '❌ Não foi possível adicionar o participante. Verifique se o bot tem permissão de admin.' }, { quoted: m });
                        }
                    }
                }

                if (!messageText && !getTargetMedia(corpoMsg)) return;

                if (messageText && messageText.startsWith(prefix) && !messageText.startsWith(`${prefix}sim`) && !messageText.startsWith(`${prefix}nao`) && !messageText.startsWith(`${prefix}não`) && !messageText.startsWith(`${prefix}cancelar`)) {
                    limparEstadosPendentes(sender, remoteJid);
                    if (avisoStateKey !== sender) {
                        limparTimeoutAviso(avisoStateKey);
                        delete aguardandoAcaoAviso[avisoStateKey];
                    }
                }

                // Mensagens enviadas pelo próprio bot também participam do sistema de XP.
                // Antes este return bloqueava o bot antes de chegar ao sistema de XP.
                if (m.key.fromMe && !(messageText && messageText.startsWith(prefix)) && !aguardandoAcaoLog[stateKey] && !aguardandoAcaoTestar[stateKey] && !aguardandoAcaoAviso[avisoStateKey] && !aguardandoGPDinheiro[stateKey]) {
                    // Não retorna: deixa o bot passar pelo sistema de XP para ter seu próprio perfil.
                }

                // 🌟 SISTEMA DE XP E ECONOMIA 🌟
                if (isGroup) {
                    const isBrincadeirasAtivo = dadosGlobais.brincadeiras && dadosGlobais.brincadeiras[remoteJid];

                    if (isBrincadeirasAtivo) {
                        if (!m.key.fromMe) {
                            resetarInatividade(remoteJid);
                        }

                        garantirEconomia(dadosGlobais, userGroupKey);

                        const mediaContabilizavel = !!getTargetMedia(corpoMsg);
                        const textoContabilizavel = !!messageText && !messageText.startsWith(prefix);
                        const podeContabilizarXP = textoContabilizavel || mediaContabilizavel;

                        if (podeContabilizarXP && !messageText.startsWith(prefix)) {
                            // Evita farm por flood: a mesma pessoa precisa alternar com outra.
                            if (ultimoRemetenteGrupo.get(remoteJid) !== sender) {
                                ultimoRemetenteGrupo.delete(remoteJid);
                                ultimoRemetenteGrupo.set(remoteJid, sender);
                                while (ultimoRemetenteGrupo.size > 2000) {
                                    ultimoRemetenteGrupo.delete(ultimoRemetenteGrupo.keys().next().value);
                                }

                                const stats = obterStatsXP(userGroupKey);
                                const progAtividade = garantirProgressoJogador(dadosGlobais, userGroupKey);
                                progAtividade.mensagens += 1;
                                progAtividade.xpGanho += 0;
                                const missaoMensagemConcluida = registrarMissao(dadosGlobais, userGroupKey, 'mensagens', 1);
                                aplicarXPPendenteDasMissoes(userGroupKey);
                                const temporadaAnterior = temporadaAtualId();
                                garantirTemporadaGrupo(dadosGlobais, remoteJid);
                                adicionarPontosTemporadaSemValidacao(dadosGlobais, remoteJid, userGroupKey, 1);
                                stats.msgCount += 1;

                                if (stats.msgCount >= XP_MSG_INTERVALO) {
                                    stats.msgCount = 0;

                                    if (stats.nivel < XP_MAX_LEVEL) {
                                        const xpGanho = Math.floor(Math.random() * (XP_MAX_GANHO - XP_MIN_GANHO + 1)) + XP_MIN_GANHO;
                                        const nivelAntes = stats.nivel;
                                        const xpAntes = stats.xp;
                                        const levelsGanhos = aplicarXP(stats, xpGanho);
                                        garantirProgressoJogador(dadosGlobais, userGroupKey).xpGanho += xpGanho;
                                        const novasConquistasXP = verificarConquistas(dadosGlobais, remoteJid, userGroupKey);
                                        const dinheiroNivel = levelsGanhos > 0
                                            ? adicionarRecompensaNivel(userGroupKey, nivelAntes, stats.nivel)
                                            : 0;

                                        await salvarDadosBot(dadosGlobais).catch(() => {});

                                        if (levelsGanhos > 0) {
                                            await sock.sendMessage(remoteJid, {
                                                text: `🎊 *LEVEL UP!* 🎊\n\n` +
                                                      `Parabéns @${cleanSender}! Você ganhou *+${xpGanho} XP* por interagir no grupo e subiu ` +
                                                      `${levelsGanhos > 1 ? `${levelsGanhos} níveis` : `para o *Nível ${stats.nivel}` }*! 🚀\n\n` +
                                                      `✨ XP antes: *${xpAntes}/${xpNecessarioNivel(nivelAntes)}*\n` +
                                                      `✨ XP atual: *${stats.nivel >= XP_MAX_LEVEL ? `0/MÁXIMO` : `${stats.xp}/${xpNecessarioNivel(stats.nivel)}`}*` +
                                                      (dinheiroNivel > 0 ? `\n💰 Recompensa de nível: *+R$ ${dinheiroNivel.toFixed(2)}*\n💵 Saldo atual: *R$ ${(Number(dadosGlobais.economia[userGroupKey]?.dinheiro) || 0).toFixed(2)}*` : ''),
                                                mentions: [sender]
                                            });
                                        } else {
                                            await sock.sendMessage(remoteJid, {
                                                text: `✨ @${cleanSender}, você ganhou *+${xpGanho} XP* por interagir! ` +
                                                      `(${stats.xp}/${xpNecessarioNivel(stats.nivel)})`,
                                                mentions: [sender]
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // O fluxo de aviso é processado ANTES dos demais fluxos interativos.
                // Assim, respostas como "sim", "s" ou "alterar" nunca são engolidas
                // por outro estado pendente.
                if (
                    messageText &&
                    !messageText.startsWith(prefix) &&
                    aguardandoAcaoAviso[avisoStateKey] &&
                    souDono
                ) {
                    const avisoProcessado = await processarRespostaAviso(
                        remoteJid,
                        m,
                        messageText,
                        avisoStateKey
                    );
                    if (avisoProcessado) return;
                }

                if (messageText && !messageText.startsWith(prefix)) {
                    // Fluxo do .gp dinheiro — somente o dono do bot pode responder às etapas.
                    if (aguardandoGPDinheiro[stateKey] && souDono) {
                        const estadoGP = aguardandoGPDinheiro[stateKey];
                        if (estadoGP.remoteJid && estadoGP.remoteJid !== remoteJid) return;
                        // Cada resposta do dono renova o prazo de inatividade de 60 segundos.
                        definirTimeoutGPDinheiro(sender, remoteJid);
                        const textoGP = messageText.trim();
                        const textoGPNormalizado = textoGP.toLowerCase();

                        if (['cancelar', 'cancel'].includes(textoGPNormalizado)) {
                            limparTimeoutGPDinheiro(sender, remoteJid);
                            delete aguardandoGPDinheiro[stateKey];
                            return await sock.sendMessage(remoteJid, { text: '❌ Administração encerrada. Nenhuma outra alteração será feita.' }, { quoted: m });
                        }

                        const textoMenuOpcoesGP = (estado) => {
                            const stats = obterStatsXP(estado.chaveParticipante);
                            const saldo = Number(dadosGlobais.economia?.[estado.chaveParticipante]?.dinheiro) || 0;
                            return `👤 *Participante:* @${normalizarJid(estado.participante)}\n💰 *Saldo:* R$ ${saldo.toFixed(2)}\n🌟 *Nível:* ${stats.nivel}\n✨ *XP:* ${stats.xp}/${stats.nivel < XP_MAX_LEVEL ? xpNecessarioNivel(stats.nivel) : 'MÁXIMO'}\n\n❓ *O que você quer alterar?*\n\n➕ 1️⃣ Aumentar dinheiro\n➕ 2️⃣ Aumentar XP\n➕ 3️⃣ Aumentar nível\n➖ 4️⃣ Diminuir dinheiro\n➖ 5️⃣ Diminuir XP\n➖ 6️⃣ Diminuir nível\n🏦 7️⃣ Cadastrar esta pessoa no Banco\n👥 8️⃣ Escolher outra pessoa\n✅ 9️⃣ Encerrar\n\nDigite uma opção, ou *cancelar*. (60 segundos)`;
                        };

                        const mostrarMenuOpcoesGP = async (estado) => {
                            aguardandoGPDinheiro[stateKey] = { ...estado, etapa: 'escolher_aumento' };
                            definirTimeoutGPDinheiro(sender, remoteJid);
                            return await enviarEIgnorar(remoteJid, {
                                text: textoMenuOpcoesGP(estado),
                                mentions: [estado.participanteMencao || estado.participante]
                            }, { quoted: m });
                        };

                        const perguntarContinuarGP = async (estado, resultado) => {
                            aguardandoGPDinheiro[stateKey] = { ...estado, etapa: 'perguntar_mais' };
                            definirTimeoutGPDinheiro(sender, remoteJid);
                            return await enviarBotoesWhatsApp(remoteJid,
                                `${resultado}\n\n❓ *Quer alterar mais alguma coisa?*\nO fluxo será cancelado após *60 segundos* sem resposta.`,
                                [ { id: '1', text: '✅ Continuar' }, { id: '2', text: '👥 Outra pessoa' }, { id: '3', text: '❌ Encerrar' } ],
                                { quoted: m, mentions: [estado.participanteMencao || estado.participante].filter(Boolean) }
                            );
                        };

                        const mostrarListaParticipantesGP = async (estado) => {
                            const linhas = estado.participantes.map((p, i) => {
                                const jid = p.phoneNumber || p.jid || p.id;
                                const chave = `${estado.grupo.jid}_${normalizarJid(jid)}`;
                                const saldo = Number(dadosGlobais.economia?.[chave]?.dinheiro) || 0;
                                const stats = obterStatsXP(chave);
                                return `${i + 1}. @${normalizarJid(jid)} — R$ ${saldo.toFixed(2)} | Nível ${stats.nivel} | XP ${stats.xp}`;
                            }).join('\n');
                            aguardandoGPDinheiro[stateKey] = { ...estado, etapa: 'escolher_participante' };
                            definirTimeoutGPDinheiro(sender, remoteJid);
                            return await enviarEIgnorar(remoteJid, {
                                text: `👥 *Escolha uma pessoa de ${estado.grupo.nome || 'este grupo'}:*\n\n${linhas}\n\nDigite o número da pessoa, marque-a com @menção ou digite *cancelar*. (60 segundos)`,
                                mentions: estado.participantes.map(p => p.phoneNumber || p.jid || p.id)
                            }, { quoted: m });
                        };

                        if (estadoGP.etapa === 'perguntar_mais') {
                            if (['1', 'sim', 's'].includes(textoGPNormalizado)) {
                                return await mostrarMenuOpcoesGP(estadoGP);
                            }
                            if (textoGPNormalizado === '2') {
                                return await mostrarListaParticipantesGP(estadoGP);
                            }
                            if (['3', 'nao', 'não', 'n'].includes(textoGPNormalizado)) {
                                limparTimeoutGPDinheiro(sender, remoteJid);
                                delete aguardandoGPDinheiro[stateKey];
                                return await sock.sendMessage(remoteJid, { text: '✅ Administração concluída. Todas as alterações realizadas foram salvas.' }, { quoted: m });
                            }
                            return await sock.sendMessage(remoteJid, { text: '❓ Responda *1* para continuar, *2* para escolher outra pessoa ou *3* para encerrar.' }, { quoted: m });
                        }

                        if (estadoGP.etapa === 'escolher_grupo') {
                            const numeroGrupo = Number.parseInt(textoGP, 10);
                            if (!Number.isInteger(numeroGrupo) || numeroGrupo < 1 || numeroGrupo > estadoGP.grupos.length) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `❌ Número inválido. Escolha um grupo entre *1 e ${estadoGP.grupos.length}*.`
                                }, { quoted: m });
                            }

                            const grupoEscolhido = estadoGP.grupos[numeroGrupo - 1];
                            try {
                                const metaGrupo = await obterMetadadosGrupoComTimeout(grupoEscolhido.jid);
                                const participantes = (metaGrupo.participants || []).filter(p => p?.id);

                                if (participantes.length === 0) {
                                    limparTimeoutGPDinheiro(sender, remoteJid);
                                    delete aguardandoGPDinheiro[stateKey];
                                    return await sock.sendMessage(remoteJid, {
                                        text: `❌ Não encontrei participantes no grupo *${metaGrupo.subject}*.`
                                    }, { quoted: m });
                                }

                                for (const p of participantes) {
                                    const jidCanonicoLista = p.phoneNumber || p.jid || p.id;

                                    if (p.id && jidCanonicoLista && p.id !== jidCanonicoLista) {
                                        await migrarDadosIdentidadeGrupo(
                                            grupoEscolhido.jid,
                                            p.id,
                                            jidCanonicoLista
                                        );
                                    }

                                    const chaveParticipante = `${grupoEscolhido.jid}_${normalizarJid(jidCanonicoLista)}`;
                                    garantirEconomia(dadosGlobais, chaveParticipante);
                                    obterStatsXP(chaveParticipante);
                                }

                                const listaParticipantes = participantes.map((p, i) => {
                                    const jidCanonicoLista = p.phoneNumber || p.jid || p.id;
                                    const chaveParticipante = `${grupoEscolhido.jid}_${normalizarJid(jidCanonicoLista)}`;
                                    const saldo = Number(dadosGlobais.economia[chaveParticipante].dinheiro) || 0;
                                    const statsLista = obterStatsXP(chaveParticipante);
                                    return `${i + 1}. @${normalizarJid(jidCanonicoLista)} — R$ ${saldo.toFixed(2)} | Nível ${statsLista.nivel} | XP ${statsLista.xp}/${statsLista.nivel < XP_MAX_LEVEL ? xpNecessarioNivel(statsLista.nivel) : 'MÁXIMO'}`;
                                }).join('\n');

                                await salvarDadosBot(dadosGlobais);
                                aguardandoGPDinheiro[stateKey] = {
                                    etapa: 'escolher_participante',
                                    grupo: grupoEscolhido,
                                    participantes
                                };
                                definirTimeoutGPDinheiro(sender, remoteJid);

                                return await enviarEIgnorar(remoteJid, {
                                    text: `💰 *GP DINHEIRO*\n\n` +
                                          `👥 *Grupo selecionado:* ${metaGrupo.subject}\n\n` +
                                          `*Participantes:*\n${listaParticipantes}\n\n` +
                                          `Digite o *número* do participante que você deseja administrar.`,
                                    mentions: participantes.map(p => p.id)
                                }, { quoted: m });
                            } catch (err) {
                                console.error('Erro ao carregar participantes no .gp dinheiro:', err);
                                limparTimeoutGPDinheiro(sender, remoteJid);
                                delete aguardandoGPDinheiro[stateKey];
                                return await sock.sendMessage(remoteJid, { text: '❌ Não foi possível carregar os participantes desse grupo.' }, { quoted: m });
                            }
                        }

                        if (estadoGP.etapa === 'escolher_participante') {
                            const numeroParticipante = Number.parseInt(textoGP, 10);
                            if (!Number.isInteger(numeroParticipante) || numeroParticipante < 1 || numeroParticipante > estadoGP.participantes.length) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `❌ Número inválido. Escolha um participante entre *1 e ${estadoGP.participantes.length}*.`
                                }, { quoted: m });
                            }

                            const participanteEscolhido = estadoGP.participantes[numeroParticipante - 1];
                            const jidParticipante = participanteEscolhido.id;
                            const jidCanonico = participanteEscolhido.phoneNumber || participanteEscolhido.jid || participanteEscolhido.id;

                            if (jidParticipante && jidCanonico && jidParticipante !== jidCanonico) {
                                await migrarDadosIdentidadeGrupo(
                                    estadoGP.grupo.jid,
                                    jidParticipante,
                                    jidCanonico
                                );
                            }

                            const chaveParticipante = await obterChaveCanonicaUsuarioGrupo(estadoGP.grupo.jid, jidCanonico);
                            garantirEconomia(dadosGlobais, chaveParticipante);
                            const statsParticipante = obterStatsXP(chaveParticipante);
                            const saldoAtual = Number(dadosGlobais.economia[chaveParticipante].dinheiro) || 0;
                            const xpNecessarioAtual = statsParticipante.nivel < XP_MAX_LEVEL ? xpNecessarioNivel(statsParticipante.nivel) : 'MÁXIMO';

                            const estadoSelecionadoGP = {
                                ...estadoGP,
                                etapa: 'escolher_aumento',
                                participante: jidCanonico,
                                participanteMencao: jidParticipante,
                                chaveParticipante,
                                saldoAtual
                            };
                            return await mostrarMenuOpcoesGP(estadoSelecionadoGP);
                        }

                        if (estadoGP.etapa === 'escolher_aumento') {
                            if (textoGP === '1') {
                                aguardandoGPDinheiro[stateKey] = { ...estadoGP, etapa: 'informar_dinheiro' };
                                definirTimeoutGPDinheiro(sender, remoteJid);
                                return await enviarEIgnorar(remoteJid, {
                                    text: `💵 Digite o valor que deseja *adicionar ao dinheiro* de @${normalizarJid(estadoGP.participante)}.\nExemplo: *500* ou *500.50*.`,
                                    mentions: [estadoGP.participanteMencao || estadoGP.participante]
                                }, { quoted: m });
                            }

                            if (textoGP === '2') {
                                aguardandoGPDinheiro[stateKey] = { ...estadoGP, etapa: 'informar_xp' };
                                definirTimeoutGPDinheiro(sender, remoteJid);
                                return await enviarEIgnorar(remoteJid, {
                                    text: `✨ Digite a quantidade de *XP* que deseja adicionar a @${normalizarJid(estadoGP.participante)}.\nExemplo: *20* ou *100*.`,
                                    mentions: [estadoGP.participanteMencao || estadoGP.participante]
                                }, { quoted: m });
                            }

                            if (textoGP === '3') {
                                aguardandoGPDinheiro[stateKey] = { ...estadoGP, etapa: 'informar_nivel' };
                                definirTimeoutGPDinheiro(sender, remoteJid);
                                return await enviarEIgnorar(remoteJid, {
                                    text: `🌟 Digite quantos *níveis* deseja adicionar a @${normalizarJid(estadoGP.participante)}.\nExemplo: *1*, *2* ou *5*.\n\n⚠️ O máximo é o *Nível ${XP_MAX_LEVEL}*.`,
                                    mentions: [estadoGP.participanteMencao || estadoGP.participante]
                                }, { quoted: m });
                            }

                            if (textoGP === '4') {
                                aguardandoGPDinheiro[stateKey] = { ...estadoGP, etapa: 'informar_dinheiro_diminuir' };
                                definirTimeoutGPDinheiro(sender, remoteJid);
                                return await enviarEIgnorar(remoteJid, {
                                    text: `💸 Digite o valor que deseja *diminuir do dinheiro* de @${normalizarJid(estadoGP.participante)}.\nExemplo: *500* ou *500.50*. O saldo nunca ficará abaixo de *R$ 0,00*.`,
                                    mentions: [estadoGP.participanteMencao || estadoGP.participante]
                                }, { quoted: m });
                            }

                            if (textoGP === '5') {
                                aguardandoGPDinheiro[stateKey] = { ...estadoGP, etapa: 'informar_xp_diminuir' };
                                definirTimeoutGPDinheiro(sender, remoteJid);
                                return await enviarEIgnorar(remoteJid, {
                                    text: `📉 Digite a quantidade de *XP* que deseja diminuir de @${normalizarJid(estadoGP.participante)}. O XP nunca ficará abaixo de *0*.`,
                                    mentions: [estadoGP.participanteMencao || estadoGP.participante]
                                }, { quoted: m });
                            }

                            if (textoGP === '6') {
                                aguardandoGPDinheiro[stateKey] = { ...estadoGP, etapa: 'informar_nivel_diminuir' };
                                definirTimeoutGPDinheiro(sender, remoteJid);
                                return await enviarEIgnorar(remoteJid, {
                                    text: `📉 Digite quantos *níveis* deseja diminuir de @${normalizarJid(estadoGP.participante)}. O nível nunca ficará abaixo do *Nível 1*.`,
                                    mentions: [estadoGP.participanteMencao || estadoGP.participante]
                                }, { quoted: m });
                            }

                            if (textoGP === '7') {
                                const grupoCadastro = estadoGP.grupo.jid;
                                const alvoBanco = estadoGP.participante;
                                const statusAntesCadastro = statusCadastroBanco(dadosGlobais, grupoCadastro, alvoBanco);
                                registrarCadastroBanco(dadosGlobais, grupoCadastro, alvoBanco);
                                const chaveBanco = await obterChaveCanonicaUsuarioGrupo(grupoCadastro, alvoBanco);
                                garantirEconomia(dadosGlobais, chaveBanco);
                                garantirProgressoJogador(dadosGlobais, chaveBanco);
                                verificarConquistas(dadosGlobais, grupoCadastro, chaveBanco);
                                await salvarDadosBot(dadosGlobais);
                                const saldoBanco = Number(dadosGlobais.economia[chaveBanco]?.dinheiro) || 0;
                                return await perguntarContinuarGP(estadoGP,
                                    `${statusAntesCadastro === 'cadastrado' ? 'ℹ️' : '✅'} *${statusAntesCadastro === 'cadastrado' ? 'CADASTRO JÁ ESTAVA ATIVO' : 'CADASTRO NO BANCO REALIZADO'}!* 🏦\n\n` +
                                    `👤 Cliente: @${normalizarJid(alvoBanco)}\n` +
                                    `💰 Saldo atual: *R$ ${saldoBanco.toFixed(2)}*\n` +
                                    `📋 Status: *cadastrado*`);
                            }

                            if (textoGP === '8') {
                                return await mostrarListaParticipantesGP(estadoGP);
                            }

                            if (textoGP === '9') {
                                limparTimeoutGPDinheiro(sender, remoteJid);
                                delete aguardandoGPDinheiro[stateKey];
                                return await sock.sendMessage(remoteJid, { text: '✅ Administração concluída. Todas as alterações realizadas foram salvas.' }, { quoted: m });
                            }

                            return await sock.sendMessage(remoteJid, { text: '❌ Escolha uma opção de *1 a 9*. A opção *7* cadastra no Banco, *8* escolhe outra pessoa e *9* encerra.' }, { quoted: m });
                        }

                        if (estadoGP.etapa === 'informar_dinheiro') {
                            const valorAdicionar = Number(textoGP.replace(',', '.'));
                            if (!Number.isFinite(valorAdicionar) || valorAdicionar <= 0) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Valor inválido. Digite um valor maior que *0*. Ex.: *100* ou *100.50*.' }, { quoted: m });
                            }

                            const dinheiroAntes = Number(dadosGlobais.economia[estadoGP.chaveParticipante]?.dinheiro) || 0;
                            dadosGlobais.economia[estadoGP.chaveParticipante].dinheiro = dinheiroAntes + valorAdicionar;
                            const dinheiroDepois = dadosGlobais.economia[estadoGP.chaveParticipante].dinheiro;
                            const statsFinal = obterStatsXP(estadoGP.chaveParticipante);
                            await salvarDadosBot(dadosGlobais);
                            return await perguntarContinuarGP(estadoGP,
                                `✅ *Dinheiro aumentado com sucesso!*\n\n` +
                                `👤 Participante: @${normalizarJid(estadoGP.participante)}\n` +
                                `💵 Adicionado: *R$ ${valorAdicionar.toFixed(2)}*\n` +
                                `💰 Saldo anterior: *R$ ${dinheiroAntes.toFixed(2)}*\n` +
                                `💰 Novo saldo: *R$ ${dinheiroDepois.toFixed(2)}*\n\n` +
                                `📋 *PERFIL ATUALIZADO*\n` +
                                `🌟 Nível: *${statsFinal.nivel}*\n` +
                                `✨ XP: *${statsFinal.xp}/${statsFinal.nivel < XP_MAX_LEVEL ? xpNecessarioNivel(statsFinal.nivel) : 'MÁXIMO'}*\n` +
                                `💰 Saldo: *R$ ${dinheiroDepois.toFixed(2)}*`);
                        }

                        if (estadoGP.etapa === 'informar_xp') {
                            const quantidadeXP = Number.parseInt(textoGP, 10);
                            if (!Number.isInteger(quantidadeXP) || quantidadeXP <= 0) {
                                return await sock.sendMessage(remoteJid, { text: '❌ XP inválido. Digite um número inteiro maior que *0*. Ex.: *20* ou *100*.' }, { quoted: m });
                            }

                            const stats = obterStatsXP(estadoGP.chaveParticipante);
                            const nivelAntes = stats.nivel;
                            const xpAntes = stats.xp;
                            const levelsGanhos = aplicarXP(stats, quantidadeXP);
                            const dinheiroNivel = levelsGanhos > 0
                                ? adicionarRecompensaNivel(estadoGP.chaveParticipante, nivelAntes, stats.nivel)
                                : 0;
                            const dinheiroAtual = Number(dadosGlobais.economia[estadoGP.chaveParticipante]?.dinheiro) || 0;
                            await salvarDadosBot(dadosGlobais);
                            return await perguntarContinuarGP(estadoGP,
                                `✅ *XP aumentado com sucesso!*\n\n` +
                                `👤 Participante: @${normalizarJid(estadoGP.participante)}\n` +
                                `✨ XP adicionado: *+${quantidadeXP}*\n` +
                                `📊 Antes: *Nível ${nivelAntes} — ${xpAntes}/${xpNecessarioNivel(nivelAntes)} XP*\n` +
                                `📈 Depois: *Nível ${stats.nivel} — ${stats.xp}/${stats.nivel < XP_MAX_LEVEL ? xpNecessarioNivel(stats.nivel) : 'MÁXIMO'} XP*\n` +
                                (levelsGanhos > 0 ? `🎊 Subiu *${levelsGanhos} nível(is)*!\n` : '') +
                                (dinheiroNivel > 0 ? `💰 Recompensa por subir de nível: *+R$ ${dinheiroNivel.toFixed(2)}*\n` : '') +
                                `\n📋 *PERFIL ATUALIZADO*\n` +
                                `🌟 Nível: *${stats.nivel}*\n✨ XP: *${stats.xp}/${stats.nivel < XP_MAX_LEVEL ? xpNecessarioNivel(stats.nivel) : 'MÁXIMO'}*\n💰 Saldo: *R$ ${dinheiroAtual.toFixed(2)}*`);
                        }

                        if (estadoGP.etapa === 'informar_nivel') {
                            const quantidadeNiveis = Number.parseInt(textoGP, 10);
                            if (!Number.isInteger(quantidadeNiveis) || quantidadeNiveis <= 0) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Quantidade inválida. Digite um número inteiro maior que *0*. Ex.: *1*, *2* ou *5*.' }, { quoted: m });
                            }

                            const stats = obterStatsXP(estadoGP.chaveParticipante);
                            const nivelAntes = stats.nivel;
                            const nivelNovo = Math.min(XP_MAX_LEVEL, nivelAntes + quantidadeNiveis);
                            stats.nivel = nivelNovo;
                            stats.xp = 0;
                            const dinheiroNivel = adicionarRecompensaNivel(estadoGP.chaveParticipante, nivelAntes, nivelNovo);
                            const dinheiroAtual = Number(dadosGlobais.economia[estadoGP.chaveParticipante]?.dinheiro) || 0;
                            await salvarDadosBot(dadosGlobais);
                            return await perguntarContinuarGP(estadoGP,
                                `✅ *Nível aumentado com sucesso!*\n\n` +
                                `👤 Participante: @${normalizarJid(estadoGP.participante)}\n` +
                                `🌟 Nível anterior: *${nivelAntes}*\n` +
                                `🌟 Novo nível: *${nivelNovo}*\n` +
                                `✨ XP foi ajustado para *0/${nivelNovo < XP_MAX_LEVEL ? xpNecessarioNivel(nivelNovo) : 'MÁXIMO'}*.\n` +
                                (dinheiroNivel > 0 ? `💰 Recompensa por subir de nível: *+R$ ${dinheiroNivel.toFixed(2)}*\n` : '') +
                                `\n📋 *PERFIL ATUALIZADO*\n` +
                                `🌟 Nível: *${stats.nivel}*\n✨ XP: *${stats.xp}/${stats.nivel < XP_MAX_LEVEL ? xpNecessarioNivel(stats.nivel) : 'MÁXIMO'}*\n💰 Saldo: *R$ ${dinheiroAtual.toFixed(2)}*`);
                        }

                        if (estadoGP.etapa === 'informar_dinheiro_diminuir') {
                            const valor = Number(textoGP.replace(',', '.'));
                            if (!Number.isFinite(valor) || valor <= 0) return await sock.sendMessage(remoteJid, { text: '❌ Valor inválido. Digite um valor maior que 0.' }, { quoted: m });
                            const conta = garantirEconomia(dadosGlobais, estadoGP.chaveParticipante);
                            const antes = Number(conta.dinheiro) || 0;
                            conta.dinheiro = Math.max(0, antes - valor);
                            await salvarDadosBot(dadosGlobais);
                            return await perguntarContinuarGP(estadoGP, `✅ *Dinheiro diminuído!*\n👤 @${normalizarJid(estadoGP.participante)}\n💸 Redução solicitada: R$ ${valor.toFixed(2)}\n💰 Saldo anterior: R$ ${antes.toFixed(2)}\n💰 Novo saldo: R$ ${conta.dinheiro.toFixed(2)}`);
                        }

                        if (estadoGP.etapa === 'informar_xp_diminuir') {
                            const valor = Number.parseInt(textoGP, 10);
                            if (!Number.isInteger(valor) || valor <= 0) return await sock.sendMessage(remoteJid, { text: '❌ XP inválido. Digite um inteiro maior que 0.' }, { quoted: m });
                            const stats = obterStatsXP(estadoGP.chaveParticipante);
                            const antes = Number(stats.xp) || 0;
                            stats.xp = Math.max(0, antes - valor);
                            await salvarDadosBot(dadosGlobais);
                            return await perguntarContinuarGP(estadoGP, `✅ *XP diminuído!*\n👤 @${normalizarJid(estadoGP.participante)}\n✨ Redução solicitada: ${valor} XP\n✨ XP anterior: ${antes}\n✨ XP atual: ${stats.xp}\nℹ️ O nível foi mantido; o XP não fica abaixo de zero.`);
                        }

                        if (estadoGP.etapa === 'informar_nivel_diminuir') {
                            const valor = Number.parseInt(textoGP, 10);
                            if (!Number.isInteger(valor) || valor <= 0) return await sock.sendMessage(remoteJid, { text: '❌ Quantidade de níveis inválida. Digite um inteiro maior que 0.' }, { quoted: m });
                            const stats = obterStatsXP(estadoGP.chaveParticipante);
                            const antes = Number(stats.nivel) || 1;
                            stats.nivel = Math.max(1, antes - valor);
                            if (stats.nivel !== antes) stats.xp = 0;
                            await salvarDadosBot(dadosGlobais);
                            return await perguntarContinuarGP(estadoGP, `✅ *Nível diminuído!*\n👤 @${normalizarJid(estadoGP.participante)}\n🌟 Nível anterior: ${antes}\n🌟 Nível atual: ${stats.nivel}\n✨ XP atual: ${stats.xp}`);
                        }
                    }

                    // Fluxo do .resetgp: reset por categoria, perfil completo ou GP inteiro.
                    if (aguardandoResetGP[stateKey] && souDono) {
                        const estadoReset = aguardandoResetGP[stateKey];
                        if (estadoReset.remoteJid && estadoReset.remoteJid !== remoteJid) return;
                        // Toda mensagem recebida dentro do fluxo renova os 60 segundos.
                        definirTimeoutResetGP(sender, remoteJid);
                        const textoReset = messageText.trim();
                        const textoResetLower = textoReset.toLowerCase();

                        const listarAlvosReset = (participantes) => participantes.map((p, i) => {
                            const jid = p.phoneNumber || p.jid || p.id;
                            const chave = `${estadoReset.grupo.jid}_${normalizarJid(jid)}`;
                            const saldo = Number(dadosGlobais.economia?.[chave]?.dinheiro) || 0;
                            const stats = dadosGlobais.xpStatus?.[chave] || { xp: 0, nivel: 1 };
                            const cadastro = bancoCadastrado(dadosGlobais, estadoReset.grupo.jid, jid) ? 'Cadastro ativo' : 'Sem cadastro';
                            return `${i + 1}. @${normalizarJid(jid)} — ${cadastro} | R$ ${saldo.toFixed(2)} | Nível ${Number(stats.nivel) || 1} | XP ${Number(stats.xp) || 0}`;
                        }).join('\n');

                        const finalizarReset = () => {
                            limparTimeoutResetGP(sender, remoteJid);
                            delete aguardandoResetGP[stateKey];
                        };

                        if (textoResetLower === 'cancelar') {
                            finalizarReset();
                            return await sock.sendMessage(remoteJid, { text: '❌ Reset cancelado. Nenhum dado foi alterado.' }, { quoted: m });
                        }

                        if (estadoReset.etapa === 'escolher_grupo') {
                            const numeroGrupoReset = Number.parseInt(textoReset, 10);
                            if (!Number.isInteger(numeroGrupoReset) || numeroGrupoReset < 1 || numeroGrupoReset > estadoReset.grupos.length) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `❌ Número inválido. Escolha um grupo entre *1 e ${estadoReset.grupos.length}* ou digite *cancelar*.`
                                }, { quoted: m });
                            }

                            const grupoReset = estadoReset.grupos[numeroGrupoReset - 1];
                            try {
                                const metaReset = await obterMetadadosGrupoComTimeout(grupoReset.jid);
                                const participantesReset = (metaReset.participants || []).filter(p => p?.id);
                                if (!participantesReset.length) {
                                    finalizarReset();
                                    return await sock.sendMessage(remoteJid, { text: `❌ Não encontrei participantes no grupo *${metaReset.subject}*.` }, { quoted: m });
                                }
                                for (const p of participantesReset) {
                                    const jidCanonico = p.phoneNumber || p.jid || p.id;
                                    if (p.id && jidCanonico && p.id !== jidCanonico) {
                                        await migrarDadosIdentidadeGrupo(grupoReset.jid, p.id, jidCanonico);
                                    }
                                }

                                aguardandoResetGP[stateKey] = {
                                    ...estadoReset,
                                    remoteJid,
                                    etapa: 'escolher_acao',
                                    grupo: { ...grupoReset, nome: metaReset.subject || grupoReset.nome },
                                    participantes: participantesReset
                                };
                                definirTimeoutResetGP(sender, remoteJid);
                                return await enviarEIgnorar(remoteJid, {
                                    text: `♻️ *RESET GP — ${metaReset.subject || grupoReset.nome}*\n\n` +
                                          `Escolha o que deseja resetar:\n\n` +
                                          `1️⃣ *Dados específicos de uma pessoa*\n` +
                                          `2️⃣ *Perfil inteiro de uma pessoa*\n` +
                                          `3️⃣ *GP inteiro* (todos os perfis deste grupo)\n` +
                                          `4️⃣ *Cancelar*\n\nDigite uma opção de *1 a 4*.`,
                                    mentions: participantesReset.map(p => p.id)
                                }, { quoted: m });
                            } catch (err) {
                                console.error('Erro ao carregar participantes no .resetgp:', err);
                                finalizarReset();
                                return await sock.sendMessage(remoteJid, { text: '❌ Não foi possível carregar os participantes desse grupo.' }, { quoted: m });
                            }
                        }

                        if (estadoReset.etapa === 'escolher_acao') {
                            if (textoReset === '1' || textoReset === '2') {
                                const modoReset = textoReset === '1' ? 'parcial' : 'completo';
                                aguardandoResetGP[stateKey] = { ...estadoReset, etapa: 'escolher_alvo', modoReset };
                                definirTimeoutResetGP(sender, remoteJid);
                                return await enviarEIgnorar(remoteJid, {
                                    text: `👥 *Selecione a pessoa no grupo ${estadoReset.grupo.nome}:*\n\n${listarAlvosReset(estadoReset.participantes)}\n\nDigite o número da pessoa, marque-a com @menção ou digite *cancelar*.`,
                                    mentions: estadoReset.participantes.map(p => p.id)
                                }, { quoted: m });
                            }
                            if (textoReset === '3') {
                                aguardandoResetGP[stateKey] = { ...estadoReset, etapa: 'confirmar_reset_grupo' };
                                definirTimeoutResetGP(sender, remoteJid);
                                return await enviarBotoesWhatsApp(remoteJid,
                                    `⚠️ *CONFIRMAÇÃO DE RESET GERAL*\n\n` +
                                    `Você vai apagar os perfis, cadastro do Banco, saldo, XP, nível, missões e outros dados de *${estadoReset.grupo.nome}*.`,
                                    [ { id: 'resetar gp', text: '⚠️ Confirmar reset' }, { id: 'cancelar', text: '❌ Cancelar' } ],
                                    { quoted: m }
                                );
                            }
                            if (textoReset === '4') {
                                finalizarReset();
                                return await sock.sendMessage(remoteJid, { text: '❌ Reset cancelado. Nenhum dado foi alterado.' }, { quoted: m });
                            }
                            return await sock.sendMessage(remoteJid, { text: '❌ Escolha *1*, *2*, *3* ou *4* (cancelar).' }, { quoted: m });
                        }

                        if (estadoReset.etapa === 'escolher_alvo') {
                            const contextoAlvoReset = corpoMsg?.extendedTextMessage?.contextInfo || m.message?.extendedTextMessage?.contextInfo || {};
                            const jidMencionadoReset = contextoAlvoReset.mentionedJid?.[0] || contextoAlvoReset.participant || null;
                            let numeroAlvo = Number.parseInt(textoReset, 10);
                            if (jidMencionadoReset) {
                                const canonicoMencionado = await resolverJidCanonicoGrupo(estadoReset.grupo.jid, jidMencionadoReset, true);
                                const indiceMencionado = estadoReset.participantes.findIndex(p =>
                                    [p.id, p.jid, p.phoneNumber, p.lid, canonicoMencionado].filter(Boolean).some(id => normalizarJid(id) === normalizarJid(canonicoMencionado || jidMencionadoReset))
                                );
                                if (indiceMencionado >= 0) numeroAlvo = indiceMencionado + 1;
                            }
                            if (!Number.isInteger(numeroAlvo) || numeroAlvo < 1 || numeroAlvo > estadoReset.participantes.length) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `❌ Número inválido. Escolha uma pessoa entre *1 e ${estadoReset.participantes.length}* ou digite *cancelar*.`
                                }, { quoted: m });
                            }
                            const participante = estadoReset.participantes[numeroAlvo - 1];
                            const jidCanonico = participante.phoneNumber || participante.jid || participante.id;
                            const chaveCanonica = await obterChaveCanonicaUsuarioGrupo(estadoReset.grupo.jid, jidCanonico);
                            const estadoComAlvo = { ...estadoReset, participanteReset: participante, jidCanonicoReset: jidCanonico, chaveReset: chaveCanonica };

                            if (estadoReset.modoReset === 'completo') {
                                aguardandoResetGP[stateKey] = { ...estadoComAlvo, etapa: 'confirmar_reset_pessoa' };
                                definirTimeoutResetGP(sender, remoteJid);
                                return await enviarBotoesWhatsApp(remoteJid,
                                    `⚠️ Você está prestes a resetar o *perfil inteiro* de @${normalizarJid(jidCanonico)} no grupo *${estadoReset.grupo.nome}*.\n\nIsso remove cadastro, dinheiro, poupança, proteção, cartão, XP, nível, conquistas, missões e estatísticas.`,
                                    [ { id: 'resetar pessoa', text: '⚠️ Resetar perfil' }, { id: 'cancelar', text: '❌ Cancelar' } ],
                                    { quoted: m, mentions: [participante.id, jidCanonico] }
                                );
                            }

                            aguardandoResetGP[stateKey] = { ...estadoComAlvo, etapa: 'escolher_categoria' };
                            definirTimeoutResetGP(sender, remoteJid);
                            return await enviarEIgnorar(remoteJid, {
                                text: `🧰 *RESET POR CATEGORIA*\n👤 Pessoa: @${normalizarJid(jidCanonico)}\n\n` +
                                      `1️⃣ Cadastro do Banco\n` +
                                      `2️⃣ Dinheiro (saldo e tempos)\n` +
                                      `3️⃣ XP e nível\n` +
                                      `4️⃣ Poupança\n` +
                                      `5️⃣ Proteção contra roubo\n` +
                                      `6️⃣ Empréstimo\n` +
                                      `7️⃣ Cartão de crédito/dívida\n` +
                                      `8️⃣ Missões e sequência diária\n` +
                                      `9️⃣ Conquistas\n` +
                                      `🔟 Estatísticas, extrato e pontos da temporada\n` +
                                      `11️⃣ Cancelar\n\nDigite o número da opção.`,
                                mentions: [participante.id, jidCanonico]
                            }, { quoted: m });
                        }

                        if (estadoReset.etapa === 'perguntar_continuar_categoria') {
                            if (['1', 'sim', 's'].includes(textoResetLower)) {
                                aguardandoResetGP[stateKey] = { ...estadoReset, etapa: 'escolher_categoria' };
                                definirTimeoutResetGP(sender, remoteJid);
                                return await enviarEIgnorar(remoteJid, {
                                    text: `🧰 *RESET POR CATEGORIA*\n👤 Pessoa: @${normalizarJid(estadoReset.jidCanonicoReset)}\n\n` +
                                          `1️⃣ Cadastro do Banco\n2️⃣ Dinheiro (saldo e tempos)\n3️⃣ XP e nível\n4️⃣ Poupança\n5️⃣ Proteção contra roubo\n6️⃣ Empréstimo\n7️⃣ Cartão de crédito/dívida\n8️⃣ Missões e sequência diária\n9️⃣ Conquistas\n🔟 Estatísticas, extrato e pontos da temporada\n11️⃣ Cancelar\n\nDigite a categoria. (60 segundos)`,
                                    mentions: [estadoReset.participanteReset?.id, estadoReset.jidCanonicoReset].filter(Boolean)
                                }, { quoted: m });
                            }
                            if (['2', 'nao', 'não', 'n'].includes(textoResetLower)) {
                                finalizarReset();
                                return await sock.sendMessage(remoteJid, { text: '✅ Administração de reset encerrada. As alterações escolhidas foram salvas.' }, { quoted: m });
                            }
                            return await sock.sendMessage(remoteJid, { text: '❓ Responda *1* para resetar outra categoria desta pessoa ou *2* para encerrar.' }, { quoted: m });
                        }

                        if (estadoReset.etapa === 'escolher_categoria') {
                            const categorias = {
                                '1': ['cadastro', 'Cadastro do Banco'],
                                '2': ['dinheiro', 'Dinheiro'],
                                '3': ['xp', 'XP e nível'],
                                '4': ['poupanca', 'Poupança'],
                                '5': ['protecao', 'Proteção contra roubo'],
                                '6': ['emprestimo', 'Empréstimo'],
                                '7': ['cartao', 'Cartão de crédito/dívida'],
                                '8': ['missoes', 'Missões e sequência diária'],
                                '9': ['conquistas', 'Conquistas'],
                                '10': ['estatisticas', 'Estatísticas, extrato e pontos da temporada']
                            };
                            if (textoReset === '11') {
                                finalizarReset();
                                return await sock.sendMessage(remoteJid, { text: '❌ Reset cancelado. Nenhum dado foi alterado.' }, { quoted: m });
                            }
                            const selecaoCategoria = categorias[textoReset];
                            if (!selecaoCategoria) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Escolha uma categoria entre *1 e 10* ou *11* para cancelar.' }, { quoted: m });
                            }
                            const resultadoReset = resetarCampoUsuarioGrupo(
                                dadosGlobais,
                                estadoReset.grupo.jid,
                                estadoReset.jidCanonicoReset,
                                selecaoCategoria[0]
                            );
                            await salvarDadosBot(dadosGlobais);
                            const pessoa = estadoReset.jidCanonicoReset;
                            aguardandoResetGP[stateKey] = { ...estadoReset, etapa: 'perguntar_continuar_categoria' };
                            definirTimeoutResetGP(sender, remoteJid);
                            return await enviarBotoesWhatsApp(remoteJid,
                                `✅ *RESET PARCIAL CONCLUÍDO*\n\n👤 Pessoa: @${normalizarJid(pessoa)}\n🧹 Categoria: *${selecaoCategoria[1]}*\n📋 Resultado: ${resultadoReset}.\n\n❓ *Deseja resetar mais alguma coisa desta pessoa?*\nVocê tem 60 segundos.`,
                                [ { id: '1', text: '♻️ Outra categoria' }, { id: '2', text: '✅ Encerrar' } ],
                                { quoted: m, mentions: [estadoReset.participanteReset.id, pessoa] }
                            );
                        }

                        if (estadoReset.etapa === 'confirmar_reset_pessoa') {
                            if (textoResetLower !== 'resetar pessoa') {
                                return await sock.sendMessage(remoteJid, { text: '❌ Para confirmar, digite *RESETAR PESSOA*. Para desistir, digite *cancelar*.' }, { quoted: m });
                            }
                            resetarDadosUsuarioGrupo(dadosGlobais, estadoReset.grupo.jid, estadoReset.jidCanonicoReset);
                            await salvarDadosBot(dadosGlobais);
                            const pessoa = estadoReset.jidCanonicoReset;
                            finalizarReset();
                            return await sock.sendMessage(remoteJid, {
                                text: `✅ *RESET COMPLETO CONCLUÍDO*\n\n👤 Pessoa: @${normalizarJid(pessoa)}\n📋 Cadastro removido; economia, XP, nível, missões, conquistas e estatísticas resetados.`,
                                mentions: [estadoReset.participanteReset.id, pessoa]
                            }, { quoted: m });
                        }

                        if (estadoReset.etapa === 'confirmar_reset_grupo') {
                            if (textoResetLower !== 'resetar gp') {
                                return await sock.sendMessage(remoteJid, { text: '❌ Para confirmar, digite exatamente *RESETAR GP*. Para desistir, digite *cancelar*.' }, { quoted: m });
                            }
                            for (const participante of estadoReset.participantes) {
                                const jidCanonico = participante.phoneNumber || participante.jid || participante.id;
                                resetarDadosUsuarioGrupo(dadosGlobais, estadoReset.grupo.jid, jidCanonico);
                            }
                            await salvarDadosBot(dadosGlobais);
                            const nomeGrupo = estadoReset.grupo.nome;
                            const totalPerfis = estadoReset.participantes.length;
                            finalizarReset();
                            return await sock.sendMessage(remoteJid, {
                                text: `✅ *RESET DO GP CONCLUÍDO*\n\n👥 Grupo: *${nomeGrupo}*\n♻️ Perfis resetados: *${totalPerfis}*\n📋 Cadastros e dados dos perfis foram removidos.`
                            }, { quoted: m });
                        }
                    }

                    if (aguardandoAcaoLog[stateKey]) {
                        const textoLimpo = messageText.trim().toLowerCase();
                        
                        if (aguardandoAcaoLog[stateKey] === 'confirmacao') {
                            if (['sim', 's'].includes(textoLimpo)) {
                                limparTimeoutLog(sender, remoteJid);
                                aguardandoAcaoLog[stateKey] = 'texto';
                                definirTimeoutLog(sender, remoteJid);
                                return await enviarEIgnorar(remoteJid, { text: '✏ Mande agora a mensagem de texto com as novidades da versão para salvar no log (você tem 30s).' }, { quoted: m });
                            } else if (['nao', 'n', 'não'].includes(textoLimpo)) {
                                limparTimeoutLog(sender, remoteJid);
                                delete aguardandoAcaoLog[stateKey];
                                return await sock.sendMessage(remoteJid, { text: '❌ Alteração de log cancelada.' }, { quoted: m });
                            }
                        } else if (aguardandoAcaoLog[stateKey] === 'texto') {
                            limparTimeoutLog(sender, remoteJid);
                            dadosGlobais.logTexto = messageText.trim();
                            await salvarDadosBot(dadosGlobais);
                            delete aguardandoAcaoLog[stateKey];
                            return await sock.sendMessage(remoteJid, { text: '✅ Log de atualizações guardado com sucesso!' }, { quoted: m });
                        }
                    }

                    if (aguardandoAcaoTestar[stateKey] && souDono) {
                        const textoLimpo = messageText.trim().toLowerCase();
                        const etapa = aguardandoAcaoTestar[stateKey].etapa;

                        if (etapa === 'confirmar_ativar') {
                            if (['sim', 's'].includes(textoLimpo)) {
                                limparTimeoutTestar(sender, remoteJid);
                                aguardandoAcaoTestar[stateKey] = { etapa: 'pergunta_motivo' };
                                definirTimeoutTestar(sender, remoteJid);
                                return await enviarBotoesWhatsApp(remoteJid, '❓ Deseja adicionar um *motivo/aviso* personalizado para o modo de testes?', [ { id: 'sim', text: '✏ Adicionar motivo' }, { id: 'nao', text: 'Usar padrão' } ], { quoted: m });
                            } else if (['nao', 'n', 'não'].includes(textoLimpo)) {
                                limparTimeoutTestar(sender, remoteJid);
                                delete aguardandoAcaoTestar[stateKey];
                                return await sock.sendMessage(remoteJid, { text: '❌ Ativação do modo de testes cancelada.' }, { quoted: m });
                            }
                        } else if (etapa === 'pergunta_motivo') {
                            if (['sim', 's'].includes(textoLimpo)) {
                                limparTimeoutTestar(sender, remoteJid);
                                aguardandoAcaoTestar[stateKey] = { etapa: 'texto_motivo' };
                                definirTimeoutTestar(sender, remoteJid);
                                return await enviarEIgnorar(remoteJid, { text: '✏️ Mande o texto do motivo/aviso do modo de testes agora (você tem 30s):' }, { quoted: m });
                            } else if (['nao', 'n', 'não'].includes(textoLimpo)) {
                                limparTimeoutTestar(sender, remoteJid);
                                dadosGlobais.modoTeste = true;
                                dadosGlobais.motivoModoTeste = null;
                                await salvarDadosBot(dadosGlobais);
                                delete aguardandoAcaoTestar[stateKey];
                                return await sock.sendMessage(remoteJid, { text: '✅ *Modo de testes ATIVADO* com a mensagem de manutenção padrão!' }, { quoted: m });
                            }
                        } else if (etapa === 'texto_motivo') {
                            limparTimeoutTestar(sender, remoteJid);
                            dadosGlobais.modoTeste = true;
                            dadosGlobais.motivoModoTeste = messageText.trim();
                            await salvarDadosBot(dadosGlobais);
                            delete aguardandoAcaoTestar[stateKey];
                            return await sock.sendMessage(remoteJid, { text: `✅ *Modo de testes ATIVADO* com o aviso:\n\n💬 "${messageText.trim()}"` }, { quoted: m });
                        } else if (etapa === 'perguntar_trocar_texto') {
                            if (['sim', 's'].includes(textoLimpo)) {
                                limparTimeoutTestar(sender, remoteJid);
                                aguardandoAcaoTestar[stateKey] = { etapa: 'texto_motivo' };
                                definirTimeoutTestar(sender, remoteJid);
                                return await enviarEIgnorar(remoteJid, { text: '✏ Mande o *novo texto/aviso* do modo de testes agora (você tem 30s):' }, { quoted: m });
                            } else if (['nao', 'n', 'não'].includes(textoLimpo)) {
                                limparTimeoutTestar(sender, remoteJid);
                                aguardandoAcaoTestar[stateKey] = { etapa: 'confirmar_desativar' };
                                definirTimeoutTestar(sender, remoteJid);
                                return await enviarBotoesWhatsApp(remoteJid, `❓ *DESATIVAR MODO TESTE*

Deseja desativar o modo de testes e liberar o bot para todos?`, [ { id: 'sim', text: '✅ Desativar' }, { id: 'nao', text: 'Manter ativo' } ], { quoted: m });
                            }
                        } else if (etapa === 'confirmar_desativar') {
                            if (['sim', 's'].includes(textoLimpo)) {
                                limparTimeoutTestar(sender, remoteJid);
                                dadosGlobais.modoTeste = false;
                                dadosGlobais.motivoModoTeste = null;
                                await salvarDadosBot(dadosGlobais);
                                delete aguardandoAcaoTestar[stateKey];
                                return await sock.sendMessage(remoteJid, { text: '✅ *Modo de testes DESATIVADO!* O bot foi liberado para todos.' }, { quoted: m });
                            } else if (['nao', 'n', 'não'].includes(textoLimpo)) {
                                limparTimeoutTestar(sender, remoteJid);
                                delete aguardandoAcaoTestar[stateKey];
                                return await sock.sendMessage(remoteJid, { text: '❌ Operação cancelada.' }, { quoted: m });
                            }
                        }
                    }
                }

                if (!dadosGlobais.botAtivo) {
                    if (souDono && messageText && messageText.trim() === `${prefix}ligar`) {
                        dadosGlobais.botAtivo = true;
                        await salvarDadosBot(dadosGlobais);
                        await sock.sendMessage(remoteJid, { text: '🟢 *ArleyBot ligado!* Estado gravado no ficheiro e a funcionar.' }, { quoted: m });
                    }
                    return;
                }

                if (!messageText || !messageText.startsWith(prefix)) {
                    if (isGroup && ['pg', 'gc'].includes(dadosGlobais.statusAluguelGrupos?.[remoteJid]) && dadosGlobais.gruposAvisos?.[remoteJid] === true) {
                        const textoPrefixoErrado = String(messageText || '').trim();
                        // Detecta qualquer prefixo de pontuação/símbolo de 1 a 3 caracteres,
                        // não apenas uma lista fixa como ! / # $ %, e só alerta se vier um comando conhecido.
                        const tentativaPrefixo = textoPrefixoErrado.match(/^([^\p{L}\p{N}\s]{1,3})([^\s]+)(?:\s|$)/u);
                        if (tentativaPrefixo) {
                            const comandoTentado = normalizarComandoSugestao(tentativaPrefixo[2]).replace(/^não$/, 'nao');
                            if (comandoTentado && COMANDOS_SUGESTAO.has(comandoTentado)) {
                                const dicaPrefixo = `⚠️ *Prefixo incorreto!*\n\n⌨️ O prefixo deste grupo é *${prefix}*.\n✅ Exemplo: *${prefix}${comandoTentado}*\n\nEste aviso só aparece porque os avisos estão ativados neste grupo.`;
                                await sock.sendMessage(remoteJid, { text: dicaPrefixo }, { quoted: m }).catch(() => {});
                            }
                        }
                    }
                    return;
                }

                const agoraComando = Date.now();
                const textoRespostaYoutube = String(messageText || '').trim().toLowerCase();
                const ehRespostaYoutubePendente = !!pendentesYouTube[userGroupKey] && [
                    `${prefix}sim`, `${prefix}nao`, `${prefix}não`, `${prefix}cancelar`
                ].includes(textoRespostaYoutube);
                // Cliques de botões são ações do fluxo em andamento, então não devem ser bloqueados
                // pelo cooldown do comando que acabou de abrir o menu.
                const mensagemInterativaRecebida = desempacotarMensagem(m.message);
                const ehRespostaDeBotao = !!(
                    mensagemInterativaRecebida.buttonsResponseMessage?.selectedButtonId ||
                    mensagemInterativaRecebida.templateButtonReplyMessage?.selectedId ||
                    mensagemInterativaRecebida.listResponseMessage?.singleSelectReply?.selectedRowId ||
                    mensagemInterativaRecebida.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson
                );
                if (!ehRespostaDeBotao && !ehRespostaYoutubePendente && cooldownsComando[stateKey] && (agoraComando - cooldownsComando[stateKey] < TEMPO_COOLDOWN_MS)) {
                    const restante = Math.ceil((TEMPO_COOLDOWN_MS - (agoraComando - cooldownsComando[stateKey])) / 1000);
                    return await sock.sendMessage(remoteJid, { 
                        text: `⏱ *@${cleanSender}*, aguarde *${restante}s* antes de enviar outro comando!`,
                        mentions: [sender]
                    }, { quoted: m });
                }
                cooldownsComando[stateKey] = agoraComando;

                const args = messageText.slice(prefix.length).trim().split(/\s+/);
                const command = (args.shift() || '')
                    .normalize('NFKC')
                    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
                    .toLowerCase()
                    .replace(/^não$/, 'nao');
                const textArgs = args.join(' ');

                if (dadosGlobais.modoTeste && !souDono) {
                    let msgManutencao = '🛠 *Em manutenção!*\n\n';
                    if (dadosGlobais.motivoModoTeste) {
                        msgManutencao += `📌 *Motivo/Aviso:* ${dadosGlobais.motivoModoTeste}\n\n`;
                    } else {
                        msgManutencao += `O bot está em modo de testes no momento.\n\n`;
                    }
                    msgManutencao += `Apenas o dono pode enviar comandos agora.\n_Por favor, aguarde._`;

                    await sock.sendMessage(remoteJid, { text: msgManutencao }, { quoted: m });
                    return;
                }

                if (COMANDOS_EXCLUSIVOS_DONO.has(command) && !souDono) {
                    return await sock.sendMessage(remoteJid, {
                        text: '❌ *Acesso negado!* Este comando é exclusivo do dono do bot.'
                    }, { quoted: m });
                }

                if (COMANDOS_ADMIN_GRUPO.has(command) && !souDono) {
                    if (!isGroup) {
                        return await sock.sendMessage(remoteJid, {
                            text: '❌ Este comando só pode ser usado por administradores dentro de um grupo.'
                        }, { quoted: m });
                    }
                    if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                        return await sock.sendMessage(remoteJid, {
                            text: '❌ *Acesso negado!* Apenas administradores do grupo ou o dono do bot podem usar este comando.'
                        }, { quoted: m });
                    }
                }

                registrarLogComandoTerminal({
                    m,
                    cleanSender,
                    remoteJid,
                    prefix,
                    command,
                    statusLabel: !textArgs.trim() ? (ROTULOS_STATUS_ALUGUEL_TERMINAL[command] || '') : ''
                });

                // Não envia presença 'composing' para evitar indicar que o dono está digitando.


                function adicionarPontosTemporadaSemValidacao(dados, groupJid, chave, pontos) {
                    if (!groupJid || !chave) return false;
                    const numero = chave.startsWith(`${groupJid}_`) ? chave.slice(groupJid.length + 1) : '';
                    if (!numero || !bancoCadastrado(dados, groupJid, `${numero}@s.whatsapp.net`)) return false;
                    if (!dados.temporadas) dados.temporadas = {};
                    const resultado = garantirTemporadaGrupo(dados, groupJid);
                    resultado.temp.pontos[chave] = (Number(resultado.temp.pontos[chave]) || 0) + Math.max(0, Number(pontos) || 0);
                    return resultado.alterou;
                }

                function aplicarXPPendenteDasMissoes(chave) {
                    const estado = dadosGlobais.missoesJogadores?.[chave];
                    const xpPendente = Number(estado?.xpPendente) || 0;
                    if (xpPendente <= 0) return 0;
                    const stats = obterStatsXP(chave);
                    const nivelAntes = stats.nivel;
                    const ganho = aplicarXP(stats, xpPendente);
                    if (nivelAntes !== stats.nivel) {
                        adicionarRecompensaNivel(chave, nivelAntes, stats.nivel);
                    }
                    estado.xpPendente = 0;
                    garantirProgressoJogador(dadosGlobais, chave).xpGanho += xpPendente;
                    return xpPendente;
                }

                try {
                    switch (command) {

                        // Fallback seguro: controles do aluguel só alteram dados e não respondem.
                        case 'pg':
                        case 'npg':
                        case 'gc': {
                            if (!souDono || !isGroup || textArgs.trim()) return;
                            if (!dadosGlobais.statusAluguelGrupos || typeof dadosGlobais.statusAluguelGrupos !== 'object') {
                                dadosGlobais.statusAluguelGrupos = {};
                            }
                            dadosGlobais.statusAluguelGrupos[remoteJid] = command;
                            if (command === 'npg') {
                                const timerExistente = temporizadoresAutorizacaoGrupo.get(remoteJid);
                                if (timerExistente?.timer) clearTimeout(timerExistente.timer);
                                temporizadoresAutorizacaoGrupo.delete(remoteJid);
                                if (!dadosGlobais.gruposAguardandoAutorizacao) dadosGlobais.gruposAguardandoAutorizacao = {};
                                dadosGlobais.gruposAguardandoAutorizacao[remoteJid] = {
                                    ...(dadosGlobais.gruposAguardandoAutorizacao[remoteJid] || {}),
                                    criadoEm: Date.now(), expiraEm: Date.now(), avisoDonoEnviado: true,
                                    motivoSaida: 'npg', saidaPendente: true, nome: remoteJid
                                };
                                await salvarDadosBot(dadosGlobais);
                                await tentarSairGrupoSemConfiguracao(remoteJid);
                                return;
                            }
                            limparAutorizacaoPendenteGrupo(remoteJid);
                            await salvarDadosBot(dadosGlobais);
                            return;
                        }

case 'sorteiar': {
    if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
    if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });

    const temaSorteio = textArgs.trim();
    if (!temaSorteio) {
        return await sock.sendMessage(remoteJid, {
            text: `🎲 Informe o que será sorteado.\nExemplo: *${prefix}sorteiar quem vai ganhar o prêmio*`
        }, { quoted: m });
    }

    try {
        const metaSorteio = await obterMetadadosGrupoComTimeout(remoteJid);
        const participantesGrupoSorteio = Array.isArray(metaSorteio.participants) ? metaSorteio.participants : [];

        // Usa o JID canônico para não selecionar a mesma pessoa duas vezes
        // caso o WhatsApp exponha IDs diferentes para um mesmo participante.
        const participantesUnicosSorteio = [];
        const chavesParticipantesSorteio = new Set();
        for (const participante of participantesGrupoSorteio) {
            const jidOriginalSorteio = participante?.phoneNumber || participante?.jid || participante?.id;
            if (!jidOriginalSorteio) continue;

            const jidSorteio = await resolverJidCanonicoGrupo(remoteJid, jidOriginalSorteio);
            const chaveSorteio = normalizarJid(jidSorteio);
            if (!chaveSorteio || chavesParticipantesSorteio.has(chaveSorteio)) continue;

            chavesParticipantesSorteio.add(chaveSorteio);
            participantesUnicosSorteio.push(jidSorteio);
        }

        if (participantesUnicosSorteio.length < 5) {
            return await sock.sendMessage(remoteJid, {
                text: '❌ Preciso de pelo menos 5 participantes diferentes no grupo para fazer esse sorteio.'
            }, { quoted: m });
        }

        // Fisher-Yates: embaralha a lista sem repetir integrantes.
        const embaralhadosSorteio = [...participantesUnicosSorteio];
        for (let i = embaralhadosSorteio.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [embaralhadosSorteio[i], embaralhadosSorteio[j]] = [embaralhadosSorteio[j], embaralhadosSorteio[i]];
        }
        const sorteados = embaralhadosSorteio.slice(0, 5);
        const mencoesSorteio = [];
        const linhasSorteio = [];
        const marcadoresSorteio = ['🏆 *VENCEDOR*', '🥈 2º sorteado', '🥉 3º sorteado', '4️⃣ 4º sorteado', '5️⃣ 5º sorteado'];

        for (let i = 0; i < sorteados.length; i++) {
            const jidSorteado = sorteados[i];
            mencoesSorteio.push(jidSorteado);
            linhasSorteio.push(`${marcadoresSorteio[i]} — @${normalizarJid(jidSorteado)}`);
        }

        return await sock.sendMessage(remoteJid, {
            text: `🎲 *SORTEIO: ${temaSorteio}*\n\n${linhasSorteio.join('\n')}`,
            mentions: mencoesSorteio
        }, { quoted: m });
    } catch (erroSorteio) {
        console.error('Erro no comando sorteiar:', erroSorteio);
        return await sock.sendMessage(remoteJid, {
            text: '❌ Não foi possível realizar o sorteio agora.'
        }, { quoted: m });
    }
}
break;

case 'rankgay': {
    if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
    if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });

    let progressoRankGay = null;
    try {
        progressoRankGay = await iniciarCarregamentoComando(remoteJid, m, 'Calculando rankgay', 'Buscando os participantes...');
        const metaBrincadeiras = await obterMetadadosGrupoComTimeout(remoteJid);
        const participantesBrincadeiras = Array.isArray(metaBrincadeiras.participants) ? metaBrincadeiras.participants : [];
        if (participantesBrincadeiras.length < 5) {
            await progressoRankGay?.falhar('São necessários pelo menos 5 participantes.');
            return await sock.sendMessage(remoteJid, { text: '❌ Preciso de pelo menos 5 participantes no grupo para fazer essa brincadeira.' }, { quoted: m });
        }

        const embaralhadoss = [...participantesBrincadeiras];
        for (let i = embaralhadoss.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [embaralhadoss[i], embaralhadoss[j]] = [embaralhadoss[j], embaralhadoss[i]];
        }
        const escolhidoss = embaralhadoss.slice(0, 5);
        const frasess = [
            'esse aqui é gay com força, chega tá até com 5 negoeskkkk😂',
            'Esse recebe pika de vários gays😎',
            'ele é mamador da parada gaykkkkk😂',
            'esse aqui eu desconfio, mas não tiro a conclusão que é kkkk🤣',
            'esse aqui é hétero pode ter certeza, e nada aviadadokkkk😂'
        ];
        const mencoess = [];
        const linhass = [];
        for (let i = 0; i < escolhidoss.length; i++) {
            const jidOriginall = escolhidoss[i].phoneNumber || escolhidoss[i].jid || escolhidoss[i].id;
            if (!jidOriginall) continue;
            const jidd = await resolverJidCanonicoGrupo(remoteJid, jidOriginall);
            mencoess.push(jidd);
            linhass.push((i + 1) + 'º lugar — @' + normalizarJid(jidd) + '\n' + frasess[i]);
        }

        const textoRankGay = '🎲 *Quem é o maior gay do grupo?*\n\nO rank do mais gay do grupo kkkk👀\n\n' + linhass.join('\n\n');
        const imagemRankGayEnviada = await enviarImagemMidiaSeExistir(remoteJid, 'rankgay.jpeg', {
            quoted: m,
            caption: textoRankGay,
            mentions: mencoess
        });
        if (imagemRankGayEnviada) {
            await progressoRankGay?.finalizar('Rank enviado!');
            return;
        }
        const respostaRankGayEditada = await progressoRankGay?.substituir({ text: textoRankGay, mentions: mencoess });
        if (respostaRankGayEditada) return respostaRankGayEditada;
        const envioRankGay = await sock.sendMessage(remoteJid, { text: textoRankGay, mentions: mencoess }, { quoted: m });
        await progressoRankGay?.finalizar('Rank enviado!');
        return envioRankGay;
    } catch (erroBrincadeira) {
        console.error('Erro na brincadeira do grupo:', erroBrincadeira);
        await progressoRankGay?.falhar('Não consegui montar o ranking.');
        return await sock.sendMessage(remoteJid, { text: '❌ Não foi possível realizar a brincadeira agora.' }, { quoted: m });
    }
}
break;

case 'rankpau': {
    if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
    if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });

    let progressoRankPau = null;
    try {
        progressoRankPau = await iniciarCarregamentoComando(remoteJid, m, 'Calculando rankpau', 'Buscando os participantes...');
        const metaBrincadeira = await obterMetadadosGrupoComTimeout(remoteJid);
        const participantesBrincadeira = Array.isArray(metaBrincadeira.participants) ? metaBrincadeira.participants : [];
        if (participantesBrincadeira.length < 5) {
            await progressoRankPau?.falhar('São necessários pelo menos 5 participantes.');
            return await sock.sendMessage(remoteJid, { text: '❌ Preciso de pelo menos 5 participantes no grupo para fazer essa brincadeira.' }, { quoted: m });
        }

        const embaralhados = [...participantesBrincadeira];
        for (let i = embaralhados.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [embaralhados[i], embaralhados[j]] = [embaralhados[j], embaralhados[i]];
        }
        const escolhidos = embaralhados.slice(0, 5);
        const frases = [
            'eita poha ele tem a pika que bate além da lua 😂',
            'a pika desse bate nas nuvens kkkkk😎',
            'eita esse aqui tem o tamanho de uma árvore qualquer kkkkkk😂',
            'esse aqui precisa de um microscópio pra ver kkkk🤣',
            'nem da pra ver tá no tamanho de um átomo KKKKKKKKK😂'
        ];
        const mencoes = [];
        const linhas = [];
        for (let i = 0; i < escolhidos.length; i++) {
            const jidOriginal = escolhidos[i].phoneNumber || escolhidos[i].jid || escolhidos[i].id;
            if (!jidOriginal) continue;
            const jid = await resolverJidCanonicoGrupo(remoteJid, jidOriginal);
            mencoes.push(jid);
            linhas.push((i + 1) + 'º lugar — @' + normalizarJid(jid) + '\n' + frases[i]);
        }

        const textoRankPau = '🎲 *Quem tem a maior pika?*\n\nO rank do mais pikudo do grupo kkkk👀\n\n' + linhas.join('\n\n');
        const imagemRankPauEnviada = await enviarImagemMidiaSeExistir(remoteJid, 'rankpau.jpeg', {
            quoted: m,
            caption: textoRankPau,
            mentions: mencoes
        });
        if (imagemRankPauEnviada) {
            await progressoRankPau?.finalizar('Rank enviado!');
            return;
        }
        const respostaRankPauEditada = await progressoRankPau?.substituir({ text: textoRankPau, mentions: mencoes });
        if (respostaRankPauEditada) return respostaRankPauEditada;
        const envioRankPau = await sock.sendMessage(remoteJid, { text: textoRankPau, mentions: mencoes }, { quoted: m });
        await progressoRankPau?.finalizar('Rank enviado!');
        return envioRankPau;
    } catch (erroBrincadeira) {
        console.error('Erro na brincadeira do grupo:', erroBrincadeira);
        await progressoRankPau?.falhar('Não consegui montar o ranking.');
        return await sock.sendMessage(remoteJid, { text: '❌ Não foi possível realizar a brincadeira agora.' }, { quoted: m });
    }
}
break;

case 'petista':
case 'bolsonarista': {
    if (!isGroup) {
        return await sock.sendMessage(remoteJid, {
            text: '❌ Este comando só funciona em grupos.'
        }, { quoted: m });
    }
    if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });

    const tipoPolitico = command === 'petista' ? 'petista' : 'bolsonarista';
    const tituloPolitico = command === 'petista'
        ? '🇧🇷 *QUEM É O MAIS PETISTA DO GRUPO?* 🌹'
        : '🇧🇷 *QUEM É O MAIS BOLSONARISTA DO GRUPO?*';
    let progressoPolitico = null;

    try {
        progressoPolitico = await iniciarCarregamentoComando(remoteJid, m, `Sorteando ${tipoPolitico}`, 'Buscando os participantes...');
        const metaPolitica = await obterMetadadosGrupoComTimeout(remoteJid);
        const participantesPolitica = Array.isArray(metaPolitica.participants)
            ? metaPolitica.participants
            : [];

        // Resolve JIDs e remove duplicatas para ninguém ser sorteado duas vezes.
        const participantesUnicosPolitica = [];
        const chavesParticipantesPolitica = new Set();
        for (const participante of participantesPolitica) {
            const jidOriginalPolitica = participante?.phoneNumber || participante?.jid || participante?.id;
            if (!jidOriginalPolitica) continue;

            const jidPolitica = await resolverJidCanonicoGrupo(remoteJid, jidOriginalPolitica);
            const chavePolitica = normalizarJid(jidPolitica);
            if (!chavePolitica || chavesParticipantesPolitica.has(chavePolitica)) continue;

            chavesParticipantesPolitica.add(chavePolitica);
            participantesUnicosPolitica.push(jidPolitica);
        }

        if (participantesUnicosPolitica.length < 5) {
            await progressoPolitico?.falhar('São necessários pelo menos 5 participantes.');
            return await sock.sendMessage(remoteJid, {
                text: '❌ Preciso de pelo menos 5 participantes diferentes no grupo para fazer esse ranking.'
            }, { quoted: m });
        }

        // Sorteia cinco integrantes sem repetição e usa a ordem como ranking da brincadeira.
        const embaralhadosPolitica = [...participantesUnicosPolitica];
        for (let i = embaralhadosPolitica.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [embaralhadosPolitica[i], embaralhadosPolitica[j]] = [embaralhadosPolitica[j], embaralhadosPolitica[i]];
        }
        const escolhidosPolitica = embaralhadosPolitica.slice(0, 5);
        const mencoesPolitica = [];
        const linhasPolitica = [];
        const marcadoresPolitica = [
            `🥇 *1º lugar — o mais ${tipoPolitico} (🤣):*`,
            '🥈 *2º lugar:*',
            '🥉 *3º lugar:*',
            '4️⃣ *4º lugar:*',
            '5️⃣ *5º lugar:*'
        ];

        for (let i = 0; i < escolhidosPolitica.length; i++) {
            const jidSorteadoPolitica = escolhidosPolitica[i];
            mencoesPolitica.push(jidSorteadoPolitica);
            linhasPolitica.push(`${marcadoresPolitica[i]} @${normalizarJid(jidSorteadoPolitica)}`);
        }

        const textoPolitico = `${tituloPolitico}\n\n🎲 *Os 5 sorteados:*\n\n${linhasPolitica.join('\n')}\n\nEsses cara é foda akakakakkaka.`;
        const imagemPoliticaEnviada = await enviarImagemMidiaSeExistir(
            remoteJid,
            tipoPolitico === 'petista' ? 'petista.jpeg' : 'bolsonarista.jpeg',
            { quoted: m, caption: textoPolitico, mentions: mencoesPolitica }
        );
        if (imagemPoliticaEnviada) {
            await progressoPolitico?.finalizar('Ranking enviado!');
            return;
        }
        const respostaPoliticaEditada = await progressoPolitico?.substituir({ text: textoPolitico, mentions: mencoesPolitica });
        if (respostaPoliticaEditada) return respostaPoliticaEditada;
        const envioPolitico = await sock.sendMessage(remoteJid, { text: textoPolitico, mentions: mencoesPolitica }, { quoted: m });
        await progressoPolitico?.finalizar('Ranking enviado!');
        return envioPolitico;
    } catch (erroPolitica) {
        console.error(`Erro no comando .${command}:`, erroPolitica);
        await progressoPolitico?.falhar('Não consegui montar o ranking.');
        return await sock.sendMessage(remoteJid, {
            text: '❌ Não foi possível realizar esse ranking agora.'
        }, { quoted: m });
    }
}
break;
                    
                        case 'sim':
                            if (pendentesYouTube[userGroupKey]) {
                                const video = pendentesYouTube[userGroupKey];
                                delete pendentesYouTube[userGroupKey];
                                if (!video || !video.expiraEm || video.expiraEm <= Date.now()) {
                                    await sock.sendMessage(remoteJid, { text: '⌛ Esta confirmação do YouTube expirou. Use .yt novamente para escolher o vídeo.' }, { quoted: m });
                                    break;
                                }

                                const chaveAudioAtivo = `youtube:${remoteJid}:${sender}`;
                                if (downloadsAtivos.size >= 2) {
                                    await sock.sendMessage(remoteJid, { text: '⏳ O bot já está processando dois downloads. Aguarde um terminar para iniciar outro.' }, { quoted: m });
                                    break;
                                }
                                downloadsAtivos.add(chaveAudioAtivo);
                                const chaveDonoAudio = chaveDonoControleDownload(remoteJid, sender);
                                const controleAudio = { cancelado: false, processo: null };
                                registrarControleDownload(chaveDonoAudio, controleAudio);
                                const outputMp3 = path.join(PASTA_TEMP, `output_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
                                let progressoAudio = null;
                                try {
                                    progressoAudio = await criarBarraProgressoWhatsApp(remoteJid, m, 'Baixando áudio do YouTube', 'audio');
                                    await progressoAudio.atualizar(8, 'Preparando o download...');
                                    const callbacksProgresso = criarCallbacksProgressoYtDlp(progressoAudio, 10, 84);
                                    await executarYtDlp([
                                        ...ARGUMENTOS_YTDLP_REDE,
                                        ...argumentosCookiesYtDlp(),
                                        ...argumentosForcarIPv4SeYouTube(video.url),
                                        '--newline', '--no-playlist', '-x', '--audio-format', 'mp3',
                                        '-o', outputMp3, video.url
                                    ], { timeoutMs: 480000, maxBuffer: 4 * 1024 * 1024, ...callbacksProgresso, controleDownload: controleAudio });
                                    verificarDownloadNaoCancelado(controleAudio);
                                    await progressoAudio.atualizar(91, 'Áudio baixado; enviando no WhatsApp...');

                                    // Verifica o arquivo real e envia o áudio em formato padrão do WhatsApp.
                                    // Evita misturar externalAdReply/fileName no payload de áudio, combinação
                                    // que pode ser renderizada de forma inconsistente em alguns clientes.
                                    const statAudioYoutube = await (await import('fs/promises')).stat(outputMp3).catch(() => null);
                                    if (!statAudioYoutube || statAudioYoutube.size <= 0) {
                                        throw new Error('O yt-dlp não gerou um arquivo MP3 válido.');
                                    }

                                    const nomeAudioYoutube = `ArleyBot_${Date.now()}.mp3`;
                                    verificarDownloadNaoCancelado(controleAudio);
                                    if (statAudioYoutube.size > 16 * 1024 * 1024) {
                                        // Arquivos grandes são enviados como documento para não exceder
                                        // o limite usual de áudio e evitar anexos quebrados/ocultos.
                                        await sock.sendMessage(remoteJid, {
                                            document: { url: outputMp3 },
                                            mimetype: 'audio/mpeg',
                                            fileName: nomeAudioYoutube,
                                            caption: '✅ Áudio do YouTube. Enviado como arquivo por ser grande.'
                                        }, { quoted: m });
                                    } else {
                                        const bufferAudioYoutube = await readFile(outputMp3);
                                        verificarDownloadNaoCancelado(controleAudio);
                                        await sock.sendMessage(remoteJid, {
                                            audio: bufferAudioYoutube,
                                            mimetype: 'audio/mpeg',
                                            ptt: false
                                        }, { quoted: m });
                                    }
                                    await progressoAudio.finalizar('MP3 enviado!');
                                } catch (erro) {
                                    if (controleAudio.cancelado || String(erro?.message || erro).includes('DOWNLOAD_CANCELADO')) {
                                        await progressoAudio?.falhar('Download cancelado pelo usuário.').catch(() => {});
                                        await sock.sendMessage(remoteJid, { text: '🛑 Download do YouTube cancelado. O arquivo temporário será removido.' }, { quoted: m }).catch(() => {});
                                    } else {
                                    console.error('Erro no download yt-dlp:', erro);
                                    const detalheErroAudio = String(erro?.message || 'Erro desconhecido.');
                                    const aviso403Audio = /HTTP Error 403|403: Forbidden|Error 403/i.test(detalheErroAudio)
                                        ? '\n\n⚠️ O YouTube recusou a solicitação (HTTP 403). O código agora escolhe a versão mais nova encontrada e tenta usar IPv4, mas isso não remove bloqueios do próprio YouTube. No Termux, atualize com `pkg update && pkg upgrade -y && pkg install python ffmpeg nodejs-lts && python3 -m pip install -U "yt-dlp[default]"` e reinicie o bot. Se ainda falhar, o YouTube pode exigir uma sessão válida ou estar limitando sua conexão; configure um cookies.txt seu por YTDLP_COOKIES_FILE.'
                                        : '';
                                    await progressoAudio?.falhar('Erro ao baixar ou converter o áudio.');
                                    await sock.sendMessage(remoteJid, { text: `❌ Ocorreu um erro ao processar o áudio.\n\n📌 ${detalheErroAudio}${aviso403Audio}` }, { quoted: m });
                                    }
                                } finally {
                                    retirarControleDownload(chaveDonoAudio, controleAudio);
                                    if (existsSync(outputMp3)) await unlink(outputMp3).catch(() => {});
                                    downloadsAtivos.delete(chaveAudioAtivo);
                                }
                            }
                            break;

                        case 'nao':
                        case 'cancelar': {
                            let cancelouPendente = false;
                            if (pendentesYouTube[userGroupKey]) {
                                delete pendentesYouTube[userGroupKey];
                                cancelouPendente = true;
                            }
                            const chaveDonoCancelamento = chaveDonoControleDownload(remoteJid, sender);
                            const canceladosAtivos = cancelarControlesDownloads(chaveDonoCancelamento);
                            if (cancelouPendente || canceladosAtivos > 0) {
                                await sock.sendMessage(remoteJid, { text: '🛑 Cancelamento solicitado. O download será interrompido e os arquivos temporários serão removidos.' }, { quoted: m });
                            } else if (command === 'cancelar') {
                                await sock.sendMessage(remoteJid, { text: 'ℹ️ Não há download ativo seu neste chat para cancelar.' }, { quoted: m });
                            }
                            break;
                        }

                        case 'link': {
                            const urlRecebida = textArgs.trim();
                            if (!urlRecebida) {
                                await sock.sendMessage(remoteJid, {
                                    text: `❌ Use assim: *${prefix}link <link do vídeo>*\n\nExemplo: ${prefix}link https://www.instagram.com/reel/...`
                                }, { quoted: m });
                                break;
                            }

                            let urlVideo;
                            try {
                                urlVideo = new URL(urlRecebida);
                                if (!['http:', 'https:'].includes(urlVideo.protocol) || urlVideo.username || urlVideo.password) {
                                    throw new Error('URL não permitida');
                                }
                                const host = urlVideo.hostname.toLowerCase();
                                const hostSemColchetes = host.replace(/^\[|\]$/g, '');
                                const ipPrivado = hostSemColchetes === '::1' || hostSemColchetes === '::' ||
                                    /^f[cd][0-9a-f]{2}:/i.test(hostSemColchetes) || /^fe80:/i.test(hostSemColchetes) ||
                                    /^(127\.|10\.|192\.168\.|169\.254\.)/.test(hostSemColchetes) ||
                                    /^172\.(1[6-9]|2\d|3[01])\./.test(hostSemColchetes) || hostSemColchetes === '0.0.0.0' ||
                                    /^\d+$/.test(hostSemColchetes) || /^0x[0-9a-f]+$/i.test(hostSemColchetes);
                                if (hostSemColchetes === 'localhost' || hostSemColchetes.endsWith('.localhost') || ipPrivado) {
                                    throw new Error('Endereço local não permitido');
                                }
                                // Remover parâmetros de compartilhamento do Instagram, que não
                                // são necessários para identificar o Reel e podem atrapalhar alguns extractors.
                                if (/(^|\.)instagram\.com$/i.test(host)) {
                                    urlVideo.search = '';
                                    urlVideo.hash = '';
                                }
                            } catch (_) {
                                await sock.sendMessage(remoteJid, {
                                    text: '❌ Link inválido. Envie um endereço público que comece com http:// ou https://.'
                                }, { quoted: m });
                                break;
                            }

                            const chaveDownload = `${remoteJid}:${sender}`;
                            if (downloadsAtivos.has(chaveDownload)) {
                                await sock.sendMessage(remoteJid, {
                                    text: '⏳ Você já tem um download em andamento neste chat. Aguarde terminar.'
                                }, { quoted: m });
                                break;
                            }

                            if (downloadsAtivos.size >= 2) {
                                await sock.sendMessage(remoteJid, {
                                    text: '⏳ O bot já está processando dois downloads. Aguarde um terminar para iniciar outro.'
                                }, { quoted: m });
                                break;
                            }

                            downloadsAtivos.add(chaveDownload);
                            const chaveDonoLink = chaveDonoControleDownload(remoteJid, sender);
                            const controleLink = { cancelado: false, processo: null };
                            registrarControleDownload(chaveDonoLink, controleLink);
                            const idDownload = `arley_link_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                            const diretorioDownload = path.join(PASTA_TEMP, idDownload);
                            const baseDownload = path.join(diretorioDownload, 'video');
                            let arquivoBaixado = '';
                            let progressoLink = null;
                            try {
                                await mkdir(diretorioDownload, { recursive: true });
                                progressoLink = await criarBarraProgressoWhatsApp(remoteJid, m, 'Baixando e preparando vídeo', 'video');
                                await progressoLink.atualizar(8, 'Verificando o link e a duração...');

                                // Primeiro verifica a duração quando o site a informa. O filtro
                                // direto do yt-dlp pode ignorar certos Reels com duração desconhecida.
                                let duracaoMetadados = null;
                                try {
                                    const resultadoInfo = await executarYtDlp([
                                        ...ARGUMENTOS_YTDLP_METADADOS,
                                        ...argumentosCookiesYtDlp(),
                                        ...argumentosForcarIPv4SeYouTube(urlVideo.toString()),
                                        '--no-warnings', '--no-playlist', '--skip-download', '--dump-single-json',
                                        urlVideo.toString()
                                    ], { timeoutMs: 30000, maxBuffer: 4 * 1024 * 1024, controleDownload: controleLink });
                                    const info = JSON.parse(resultadoInfo.stdout.trim());
                                    if (Number.isFinite(Number(info.duration))) {
                                        duracaoMetadados = Number(info.duration);
                                    }
                                } catch (erroInfo) {
                                    if (!controleLink.cancelado) console.warn('[.link] Não consegui confirmar a duração antes do download; vou validar o arquivo depois:', erroInfo?.message || erroInfo);
                                }
                                verificarDownloadNaoCancelado(controleLink);

                                if (duracaoMetadados !== null && duracaoMetadados > LIMITE_DURACAO_LINK_SEGUNDOS) {
                                    throw new Error(`DURACAO_EXCEDIDA: o vídeo tem ${Math.ceil(duracaoMetadados)} segundos; o limite é de ${LIMITE_DURACAO_LINK_SEGUNDOS} segundos.`);
                                }

                                await progressoLink.atualizar(20, 'Iniciando download...');
                                const callbacksProgressoLink = criarCallbacksProgressoYtDlp(progressoLink, 22, 82);
                                const resultadoDownload = await executarYtDlp([
                                    ...ARGUMENTOS_YTDLP_REDE,
                                    ...argumentosCookiesYtDlp(),
                                    ...argumentosForcarIPv4SeYouTube(urlVideo.toString()),
                                    '--newline', '--no-playlist',
                                    '--no-part',
                                    '--restrict-filenames',
                                    '--no-write-info-json',
                                    '--no-write-thumbnail',
                                    '--max-filesize', '250M',
                                    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
                                    '--merge-output-format', 'mp4',
                                    '-o', `${baseDownload}.%(ext)s`,
                                    '--print', 'after_move:filepath',
                                    urlVideo.toString()
                                ], { timeoutMs: 480000, maxBuffer: 4 * 1024 * 1024, ...callbacksProgressoLink, controleDownload: controleLink });
                                verificarDownloadNaoCancelado(controleLink);
                                await progressoLink.atualizar(85, 'Download concluído; verificando o arquivo...');

                                // Prefere o caminho impresso pelo yt-dlp, mas valida dentro da
                                // pasta exclusiva do job e aceita os contêineres de vídeo suportados.
                                const caminhoImpresso = resultadoDownload.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
                                if (caminhoImpresso && existsSync(caminhoImpresso)) {
                                    arquivoBaixado = caminhoImpresso;
                                }
                                if (!arquivoBaixado) {
                                    const nomes = await readdir(diretorioDownload);
                                    const extensoesVideo = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.flv', '.mpeg', '.mpg', '.ts']);
                                    const candidato = nomes
                                        .filter(nome => extensoesVideo.has(path.extname(nome).toLowerCase()))
                                        .map(nome => path.join(diretorioDownload, nome))
                                        .find(caminho => existsSync(caminho));
                                    if (candidato) arquivoBaixado = candidato;
                                }

                                if (!arquivoBaixado || !existsSync(arquivoBaixado)) {
                                    const saida = String(resultadoDownload.stdout || '').trim().slice(-700);
                                    const diagnostico = String(resultadoDownload.stderr || '').trim().slice(-700);
                                    console.error('[.link] yt-dlp concluiu sem arquivo.', { pasta: diretorioDownload, stdout: saida, stderr: diagnostico });
                                    throw new Error(`O yt-dlp não criou um arquivo de vídeo. ${diagnostico || saida || 'Sem detalhes adicionais no retorno do programa.'}`);
                                }

                                // Limite físico de armazenamento antes de abrir o arquivo no FFmpeg.
                                verificarDownloadNaoCancelado(controleLink);
                                const statDownload = await (await import('fs/promises')).stat(arquivoBaixado).catch(() => null);
                                if (!statDownload || statDownload.size <= 0) {
                                    throw new Error('O arquivo baixado está vazio ou não pode ser lido.');
                                }
                                if (statDownload.size > 250 * 1024 * 1024) {
                                    throw new Error('O vídeo original ultrapassou o limite de 250 MiB. O download foi cancelado para proteger o armazenamento do celular.');
                                }

                                // Validação final de duração: evita enviar vídeos acima do limite configurado
                                // quando o extractor não forneceu duração no primeiro passo.
                                const resultadoProbe = await executarProcesso('ffprobe', [
                                    '-v', 'error', '-show_entries', 'format=duration',
                                    '-of', 'default=noprint_wrappers=1:nokey=1', arquivoBaixado
                                ], { timeoutMs: 30000, maxBuffer: 1024 * 1024, controleDownload: controleLink });
                                const duracaoReal = Number(resultadoProbe.stdout.trim());
                                if (!Number.isFinite(duracaoReal) || duracaoReal <= 0) {
                                    throw new Error('Não consegui confirmar a duração do vídeo com ffprobe. Verifique se o FFmpeg/ffprobe está instalado no Termux.');
                                }
                                if (duracaoReal > LIMITE_DURACAO_LINK_SEGUNDOS) {
                                    throw new Error(`DURACAO_EXCEDIDA: o vídeo tem ${Math.ceil(duracaoReal)} segundos; o limite é de ${LIMITE_DURACAO_LINK_SEGUNDOS} segundos.`);
                                }
                                // Converte o vídeo inteiro para um MP4 compatível com o Status.
                                // Vídeos dentro do limite são enviados como um único arquivo.
                                const videoConvertido = path.join(diretorioDownload, `ArleyBot_${ARLEYBOT_VERSION}_Status.mp4`);
                                await progressoLink.atualizar(89, 'Convertendo vídeo para MP4 compatível...');
                                await executarProcesso('ffmpeg', [
                                    '-y', '-hide_banner', '-loglevel', 'error',
                                    '-i', arquivoBaixado,
                                    '-map', '0:v:0',
                                    '-map', '0:a:0?',
                                    '-vf', "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=30",
                                    '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '24',
                                    '-maxrate', '2500k', '-bufsize', '5000k',
                                    '-profile:v', 'baseline', '-level:v', '3.1', '-pix_fmt', 'yuv420p',
                                    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '44100',
                                    '-movflags', '+faststart', '-map_metadata', '-1',
                                    videoConvertido
                                ], { timeoutMs: 360000, maxBuffer: 2 * 1024 * 1024, controleDownload: controleLink });

                                const statConvertido = await (await import('fs/promises')).stat(videoConvertido).catch(() => null);
                                if (!statConvertido || statConvertido.size === 0) {
                                    throw new Error('O FFmpeg não gerou o MP4 convertido para o Status.');
                                }

                                const probeConvertido = await executarProcesso('ffprobe', [
                                    '-v', 'error', '-show_entries', 'format=duration',
                                    '-of', 'default=noprint_wrappers=1:nokey=1', videoConvertido
                                ], { timeoutMs: 30000, maxBuffer: 1024 * 1024, controleDownload: controleLink });
                                const duracaoConvertida = Number(probeConvertido.stdout.trim());
                                if (!Number.isFinite(duracaoConvertida) || duracaoConvertida <= 0 || duracaoConvertida > LIMITE_DURACAO_LINK_SEGUNDOS) {
                                    throw new Error(`O vídeo convertido tem duração inválida (${probeConvertido.stdout.trim()}s); o limite é ${LIMITE_DURACAO_LINK_SEGUNDOS} segundos.`);
                                }

                                verificarDownloadNaoCancelado(controleLink);
                                await progressoLink.atualizar(96, 'Vídeo pronto; enviando no WhatsApp...');
                                await sock.sendMessage(remoteJid, {
                                    video: { url: videoConvertido },
                                    mimetype: 'video/mp4',
                                    fileName: `ArleyBot_${ARLEYBOT_VERSION}_Status.mp4`,
                                    caption: `✅ Vídeo convertido para MP4 compatível com o Status pelo ArleyBot ${ARLEYBOT_VERSION}!`
                                }, { quoted: m });
                                await progressoLink.finalizar('Vídeo enviado!');
                            } catch (erro) {
                                if (controleLink.cancelado || String(erro?.message || erro).includes('DOWNLOAD_CANCELADO')) {
                                    await progressoLink?.falhar('Download cancelado pelo usuário.').catch(() => {});
                                    await sock.sendMessage(remoteJid, { text: '🛑 Download do link cancelado. Os arquivos temporários serão removidos.' }, { quoted: m }).catch(() => {});
                                } else {
                                console.error('[.link] Falha ao baixar vídeo:', erro?.message || erro);
                                const detalhe = String(erro?.message || 'Erro desconhecido');
                                const mensagemErro = detalhe.includes('DURACAO_EXCEDIDA')
                                    ? `❌ Este vídeo ultrapassa o limite de ${LIMITE_DURACAO_LINK_SEGUNDOS} segundos.\n\n${detalhe.replace('DURACAO_EXCEDIDA: ', '')}`
                                    : /ENOENT.*yt-dlp|spawn yt-dlp/i.test(detalhe)
                                        ? '❌ Não encontrei o yt-dlp. No Termux, instale/atualize com `python3 -m pip install -U \"yt-dlp[default]\"` e tente novamente.'
                                        : /spawn ffprobe|ffprobe.*ENOENT/i.test(detalhe)
                                            ? '❌ Não encontrei o ffprobe. Instale o FFmpeg no Termux (ele inclui o ffprobe) e tente novamente.'
                                            : /timed out|TransportError|ENOTFOUND|EAI_AGAIN|ECONNRESET|Temporary failure in name resolution/i.test(detalhe)
                                                ? '🌐 O site demorou para responder ou a conexão caiu durante o download. Confira a internet e tente novamente.'
                                                : /instagram.*(shared data|metadata extraction|login)|unable to extract shared data|General metadata extraction failed|login required|HTTP Error 403|403: Forbidden/i.test(detalhe)
                                                    ? `🔐 O Instagram bloqueou a extração ou está exigindo login/cookies. Atualize o yt-dlp com \"python3 -m pip install -U 'yt-dlp[default]'\". Se o Reel exigir conta, exporte cookies da sua própria sessão em formato Netscape, guarde o arquivo fora da pasta pública do projeto e inicie o bot com YTDLP_COOKIES_FILE=/caminho/privado/cookies.txt. Não compartilhe esse arquivo: ele permite acesso à sua sessão.\n\nDetalhe: ${detalhe.slice(0, 350)}`
                                                    : `❌ Não consegui baixar esse vídeo. O site pode exigir login, bloquear a solicitação ou não liberar esse conteúdo.\n\nDetalhe: ${detalhe.slice(0, 500)}`;
                                await progressoLink?.falhar(mensagemErro.split('\n')[0].slice(0, 180));
                                await sock.sendMessage(remoteJid, { text: mensagemErro }, { quoted: m }).catch(() => {});
                                }
                            } finally {
                                controleLink.cancelado = controleLink.cancelado || false;
                                retirarControleDownload(chaveDonoLink, controleLink);
                                await rm(diretorioDownload, { recursive: true, force: true }).catch(() => {});
                                downloadsAtivos.delete(chaveDownload);
                            }
                            break;
                        }

                        case 'velha':
                        case 'jogodavelha':
                        case 'jogar': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '🎮 O jogo da velha só funciona em grupos.' }, { quoted: m });
                            podarMinigamesExpirados();
                            const entradaVelha = String(textArgs || '').trim();
                            const partesVelha = entradaVelha.split(/\s+/).filter(Boolean);
                            const posicaoTextoVelha = partesVelha[0] || '';
                            const tokenBotaoVelha = partesVelha[1] || '';
                            let jogoVelha = jogosDaVelha.get(remoteJid);
                            let desafioVelha = desafiosVelhaPendentes.get(remoteJid);

                            if (desafioVelha && Date.now() >= desafioVelha.expiraEm) {
                                desafiosVelhaPendentes.delete(remoteJid);
                                desafioVelha = null;
                            }

                            if (jogoVelha && Date.now() - (jogoVelha.ultimaAtividade || jogoVelha.criadoEm) > TTL_JOGO_VELHA_MS) {
                                jogosDaVelha.delete(remoteJid);
                                jogoVelha = null;
                                if (/^\d+$/.test(posicaoTextoVelha)) {
                                    await sock.sendMessage(remoteJid, { text: '⌛ A partida anterior expirou. Comece outra com *.velha*.' }, { quoted: m });
                                    break;
                                }
                            }

                            if (/^cancelar$/i.test(posicaoTextoVelha)) {
                                if (jogoVelha) {
                                    const autorPodeCancelar = [jogoVelha.jogadorX, jogoVelha.jogadorO].some(j => j !== 'BOT' && normalizarJid(j) === normalizarJid(senderCanonico));
                                    if (!autorPodeCancelar && !souDono && !(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                        await sock.sendMessage(remoteJid, { text: '❌ Só quem está jogando, um administrador ou o dono pode cancelar esta partida.' }, { quoted: m });
                                        break;
                                    }
                                    jogosDaVelha.delete(remoteJid);
                                    await sock.sendMessage(remoteJid, { text: '🛑 Partida de jogo da velha cancelada.' }, { quoted: m });
                                    break;
                                }
                                if (desafioVelha) {
                                    if (normalizarJid(senderCanonico) !== normalizarJid(desafioVelha.desafiante) && !souDono && !(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                        await sock.sendMessage(remoteJid, { text: '❌ Só quem enviou o desafio, um administrador ou o dono pode cancelá-lo.' }, { quoted: m });
                                        break;
                                    }
                                    desafiosVelhaPendentes.delete(remoteJid);
                                    await sock.sendMessage(remoteJid, { text: '🛑 Convite do jogo da velha cancelado.' }, { quoted: m });
                                    break;
                                }
                                await sock.sendMessage(remoteJid, { text: 'ℹ️ Não há partida nem convite de jogo da velha ativo neste grupo.' }, { quoted: m });
                                break;
                            }

                            if (jogoVelha && /^\d+$/.test(posicaoTextoVelha)) {
                                const posicao = Number(posicaoTextoVelha) - 1;
                                if (posicao < 0 || posicao > 8) {
                                    await sock.sendMessage(remoteJid, { text: `❌ Escolha uma casa de 1 a 9. Exemplo: *${prefix}jogar 5*.` }, { quoted: m });
                                    break;
                                }
                                // Botões antigos são recusados se o tabuleiro mudou desde o envio.
                                if (tokenBotaoVelha && tokenBotaoVelha !== jogoVelha.tokenAtual) {
                                    await sock.sendMessage(remoteJid, { text: '⌛ Esse botão pertence a um tabuleiro anterior. Use os botões da mensagem mais recente.' }, { quoted: m });
                                    break;
                                }
                                const marcaTurno = jogoVelha.proximo;
                                const jogadorTurno = marcaTurno === 'X' ? jogoVelha.jogadorX : jogoVelha.jogadorO;
                                if (jogadorTurno === 'BOT' || normalizarJid(jogadorTurno) !== normalizarJid(senderCanonico)) {
                                    await sock.sendMessage(remoteJid, { text: '⏳ Ainda não é a sua vez. Aguarde o outro jogador.' }, { quoted: m });
                                    break;
                                }
                                if (jogoVelha.tabuleiro[posicao]) {
                                    await sock.sendMessage(remoteJid, { text: '❌ Essa casa já está ocupada. Escolha outra casa livre.' }, { quoted: m });
                                    break;
                                }

                                jogoVelha.tabuleiro[posicao] = marcaTurno;
                                jogoVelha.ultimaAtividade = Date.now();
                                let resultadoVelha = encontrarVencedorVelha(jogoVelha.tabuleiro);
                                if (!resultadoVelha && jogoVelha.contraBot && marcaTurno === 'X') {
                                    const jogadaBot = escolherJogadaBotVelha(jogoVelha.tabuleiro);
                                    if (jogadaBot >= 0) jogoVelha.tabuleiro[jogadaBot] = 'O';
                                    resultadoVelha = encontrarVencedorVelha(jogoVelha.tabuleiro);
                                }

                                if (resultadoVelha) {
                                    jogosDaVelha.delete(remoteJid);
                                    let resultadoTexto;
                                    if (resultadoVelha === 'EMPATE') resultadoTexto = '🤝 *Deu velha! A partida terminou empatada.*';
                                    else if (resultadoVelha === 'X') resultadoTexto = `🏆 *Vitória de ❌!* ${jogoVelha.contraBot ? 'Você venceu o ArleyBot!' : `Venceu @${normalizarJid(jogoVelha.jogadorX)}.`}`;
                                    else resultadoTexto = `🏆 *Vitória de ⭕!* ${jogoVelha.contraBot ? 'O ArleyBot venceu desta vez!' : `Venceu @${normalizarJid(jogoVelha.jogadorO)}.`}`;
                                    const mencoesVelha = [jogoVelha.jogadorX, jogoVelha.jogadorO].filter(j => j && j !== 'BOT');
                                    await sock.sendMessage(remoteJid, { text: `🎮 *JOGO DA VELHA — FIM DE PARTIDA*\n\n${renderizarTabuleiroVelha(jogoVelha.tabuleiro)}\n\n${resultadoTexto}`, mentions: mencoesVelha }, { quoted: m });
                                } else {
                                    jogoVelha.proximo = jogoVelha.contraBot ? 'X' : marcaTurno === 'X' ? 'O' : 'X';
                                    const jidProximo = jogoVelha.proximo === 'X' ? jogoVelha.jogadorX : jogoVelha.jogadorO;
                                    const textoProximo = jidProximo === 'BOT' ? '🤖 ArleyBot está jogando.' : `👉 Vez de @${normalizarJid(jidProximo)} (${jogoVelha.proximo === 'X' ? '❌' : '⭕'}).`;
                                    await enviarPainelTabuleiroVelha(remoteJid, jogoVelha, prefix, textoProximo, { quoted: m });
                                }
                                break;
                            }

                            if (jogoVelha) {
                                const turnoAtual = jogoVelha.proximo === 'X' ? jogoVelha.jogadorX : jogoVelha.jogadorO;
                                const textoTurno = turnoAtual === 'BOT' ? '🤖 ArleyBot está jogando.' : `👉 Vez de @${normalizarJid(turnoAtual)} (${jogoVelha.proximo === 'X' ? '❌' : '⭕'}).`;
                                await enviarPainelTabuleiroVelha(remoteJid, jogoVelha, prefix, textoTurno, { quoted: m });
                                break;
                            }

                            if (/^\d+$/.test(posicaoTextoVelha)) {
                                await sock.sendMessage(remoteJid, { text: `❌ Não há partida ativa. Para começar, use *${prefix}velha* (contra o bot) ou *${prefix}velha @pessoa* (desafio para alguém do grupo).` }, { quoted: m });
                                break;
                            }

                            if (desafioVelha) {
                                await sock.sendMessage(remoteJid, { text: `⏳ Já existe um convite pendente neste grupo para @${normalizarJid(desafioVelha.desafiado)}. Aguarde a resposta ou use *${prefix}velha cancelar* se você criou o convite.`, mentions: [desafioVelha.desafiado] }, { quoted: m });
                                break;
                            }

                            if (jogosDaVelha.size >= MAX_MINIGAMES_POR_GRUPOS) podarMinigamesExpirados();
                            if (jogosDaVelha.has(remoteJid)) {
                                await sock.sendMessage(remoteJid, { text: '⏳ Já existe uma partida ativa neste grupo.' }, { quoted: m });
                                break;
                            }

                            const contraBot = !entradaVelha || /^(bot|arley|arleybot|robo|robô)$/i.test(entradaVelha);
                            let jogadorO = 'BOT';
                            if (!contraBot) {
                                let alvoVelha = await obterMencionado(desempacotarMensagem(m.message), m);
                                if (!alvoVelha) {
                                    await sock.sendMessage(remoteJid, { text: `❌ Marque a pessoa que quer desafiar.\nExemplo: *${prefix}velha @pessoa*\nPara jogar contra o bot: *${prefix}velha bot*.` }, { quoted: m });
                                    break;
                                }
                                alvoVelha = await resolverJidCanonicoGrupo(remoteJid, alvoVelha);
                                if (normalizarJid(alvoVelha) === normalizarJid(senderCanonico) || normalizarJid(alvoVelha) === normalizarJid(getBotJid())) {
                                    await sock.sendMessage(remoteJid, { text: '❌ Escolha outra pessoa do grupo para jogar contra você.' }, { quoted: m });
                                    break;
                                }
                                try {
                                    const metaVelha = await obterMetadadosGrupoComTimeout(remoteJid);
                                    const participanteExiste = (metaVelha.participants || []).some(p => [p?.id, p?.jid, p?.phoneNumber, p?.lid].filter(Boolean).some(j => normalizarJid(j) === normalizarJid(alvoVelha)));
                                    if (!participanteExiste) {
                                        await sock.sendMessage(remoteJid, { text: '❌ Não consegui confirmar que essa pessoa faz parte do grupo.' }, { quoted: m });
                                        break;
                                    }
                                } catch {
                                    await sock.sendMessage(remoteJid, { text: '🌐 Não consegui consultar os participantes do grupo agora. Tente novamente.' }, { quoted: m });
                                    break;
                                }
                                jogadorO = alvoVelha;
                            }

                            if (!contraBot) {
                                const conviteId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
                                const conviteVelha = {
                                    id: conviteId,
                                    remoteJid,
                                    desafiante: senderCanonico,
                                    desafiado: jogadorO,
                                    criadoEm: Date.now(),
                                    expiraEm: Date.now() + TTL_DESAFIO_VELHA_MS
                                };
                                desafiosVelhaPendentes.set(remoteJid, conviteVelha);
                                await enviarBotoesWhatsApp(remoteJid,
                                    `⚔️ *DESAFIO DE JOGO DA VELHA*\n\n@${normalizarJid(senderCanonico)} desafiou @${normalizarJid(jogadorO)} para uma partida.\n\n@${normalizarJid(jogadorO)}, você aceita? O convite expira em 60 segundos.`,
                                    [
                                        { id: `${prefix}velhaaceitar ${conviteId}`, text: '✅ Aceitar desafio' },
                                        { id: `${prefix}velharecusar ${conviteId}`, text: '❌ Recusar' }
                                    ],
                                    { quoted: m, mentions: [senderCanonico, jogadorO] }
                                );
                                break;
                            }

                            const jogoNovoVelha = {
                                id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
                                criadoEm: Date.now(), ultimaAtividade: Date.now(),
                                tabuleiro: Array(9).fill(null), jogadorX: senderCanonico,
                                jogadorO: 'BOT', contraBot: true, proximo: 'X', tokenAtual: ''
                            };
                            jogosDaVelha.set(remoteJid, jogoNovoVelha);
                            await enviarPainelTabuleiroVelha(remoteJid, jogoNovoVelha, prefix, `👉 Vez de @${normalizarJid(senderCanonico)} (❌).`, { quoted: m });
                            break;
                        }

                        case 'velhaaceitar':
                        case 'velharecusar': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '🎮 Convites do jogo da velha só funcionam em grupos.' }, { quoted: m });
                            podarMinigamesExpirados();
                            const idConviteResposta = String(args[0] || '').trim();
                            const conviteAtualVelha = desafiosVelhaPendentes.get(remoteJid);
                            if (!conviteAtualVelha || !idConviteResposta || conviteAtualVelha.id !== idConviteResposta || Date.now() >= conviteAtualVelha.expiraEm) {
                                if (conviteAtualVelha && Date.now() >= conviteAtualVelha.expiraEm) desafiosVelhaPendentes.delete(remoteJid);
                                return await sock.sendMessage(remoteJid, { text: '⌛ Este convite não existe mais ou já expirou.' }, { quoted: m });
                            }
                            if (normalizarJid(senderCanonico) !== normalizarJid(conviteAtualVelha.desafiado)) {
                                return await sock.sendMessage(remoteJid, { text: '🔒 Só a pessoa desafiada pode aceitar ou recusar este convite.', mentions: [conviteAtualVelha.desafiado] }, { quoted: m });
                            }
                            desafiosVelhaPendentes.delete(remoteJid);
                            if (command === 'velharecusar') {
                                return await sock.sendMessage(remoteJid, { text: `❌ @${normalizarJid(conviteAtualVelha.desafiado)} recusou o desafio de jogo da velha.`, mentions: [conviteAtualVelha.desafiante, conviteAtualVelha.desafiado] }, { quoted: m });
                            }
                            if (jogosDaVelha.has(remoteJid)) {
                                return await sock.sendMessage(remoteJid, { text: '⏳ Já existe uma partida ativa neste grupo; o convite foi encerrado.' }, { quoted: m });
                            }
                            const jogoAceitoVelha = {
                                id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
                                criadoEm: Date.now(), ultimaAtividade: Date.now(),
                                tabuleiro: Array(9).fill(null), jogadorX: conviteAtualVelha.desafiante,
                                jogadorO: conviteAtualVelha.desafiado, contraBot: false, proximo: 'X', tokenAtual: ''
                            };
                            jogosDaVelha.set(remoteJid, jogoAceitoVelha);
                            return await enviarPainelTabuleiroVelha(remoteJid, jogoAceitoVelha, prefix,
                                `✅ Desafio aceito! Vez de @${normalizarJid(jogoAceitoVelha.jogadorX)} (❌) começar.`,
                                { quoted: m });
                        }

                        case 'adivinhar':
                        case 'chute': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '🎲 O jogo de adivinhar só funciona em grupos.' }, { quoted: m });
                            podarMinigamesExpirados();
                            const entradaAdivinhar = String(textArgs || '').trim().toLowerCase();
                            let jogoAdivinhar = jogosAdivinhar.get(remoteJid);

                            if (jogoAdivinhar && entradaAdivinhar === 'cancelar') {
                                if (normalizarJid(jogoAdivinhar.criador) !== normalizarJid(senderCanonico) && !souDono && !(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                    await sock.sendMessage(remoteJid, { text: '❌ Só quem iniciou o jogo, um administrador ou o dono pode cancelá-lo.' }, { quoted: m });
                                    break;
                                }
                                jogosAdivinhar.delete(remoteJid);
                                await sock.sendMessage(remoteJid, { text: '🛑 Jogo de adivinhar cancelado.' }, { quoted: m });
                                break;
                            }

                            if (jogoAdivinhar && Date.now() - jogoAdivinhar.criadoEm > TTL_ADIVINHAR_MS) {
                                jogosAdivinhar.delete(remoteJid);
                                jogoAdivinhar = null;
                            }

                            if (!jogoAdivinhar) {
                                if (entradaAdivinhar === 'cancelar' || entradaAdivinhar === 'cancel') {
                                    await sock.sendMessage(remoteJid, { text: 'ℹ️ Não há jogo de adivinhar ativo para cancelar.' }, { quoted: m });
                                    break;
                                }
                                if (/^\d+$/.test(entradaAdivinhar)) {
                                    await sock.sendMessage(remoteJid, { text: `❌ Não há jogo ativo. Inicie com *${prefix}adivinhar* e depois tente um número de 1 a 20.` }, { quoted: m });
                                    break;
                                }
                                if (jogosAdivinhar.size >= MAX_MINIGAMES_POR_GRUPOS) jogosAdivinhar.delete(jogosAdivinhar.keys().next().value);
                                jogoAdivinhar = { alvo: 1 + Math.floor(Math.random() * 20), criadoEm: Date.now(), criador: senderCanonico, tentativas: 0 };
                                jogosAdivinhar.set(remoteJid, jogoAdivinhar);
                                await sock.sendMessage(remoteJid, { text: `🎲 *ADIVINHE O NÚMERO*\n\nPensei em um número de *1 a 20*. Quem acertar primeiro ganha!\nEnvie *${prefix}adivinhar 1* até *${prefix}adivinhar 20*.\nPara encerrar: *${prefix}adivinhar cancelar*.\n_O jogo expira após 5 minutos._` }, { quoted: m });
                                break;
                            }

                            if (!/^\d+$/.test(entradaAdivinhar)) {
                                await sock.sendMessage(remoteJid, { text: `🎲 Já existe um jogo ativo neste grupo. Dê um palpite de *1 a 20* com *${prefix}adivinhar 12*.` }, { quoted: m });
                                break;
                            }
                            const palpite = Number(entradaAdivinhar);
                            if (!Number.isInteger(palpite) || palpite < 1 || palpite > 20) {
                                await sock.sendMessage(remoteJid, { text: '❌ O palpite precisa ser um número inteiro de 1 a 20.' }, { quoted: m });
                                break;
                            }
                            jogoAdivinhar.tentativas++;
                            if (palpite === jogoAdivinhar.alvo) {
                                jogosAdivinhar.delete(remoteJid);
                                await sock.sendMessage(remoteJid, { text: `🏆 *ACERTOU!* @${normalizarJid(senderCanonico)} encontrou o número *${jogoAdivinhar.alvo}* em ${jogoAdivinhar.tentativas} palpite(s)! 🎉`, mentions: [senderCanonico] }, { quoted: m });
                            } else {
                                await sock.sendMessage(remoteJid, { text: `${palpite < jogoAdivinhar.alvo ? '⬆️ Muito baixo!' : '⬇️ Muito alto!'} Tente outro número de 1 a 20.` }, { quoted: m });
                            }
                            break;
                        }

                        case 'cobra': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '🐍 A cobrinha só funciona em grupos.' }, { quoted: m });
                            podarMinigamesExpirados();
                            const entradaCobra = String(textArgs || '').trim().toLowerCase();
                            let jogoCobra = jogosCobrinha.get(remoteJid);
                            if (['cancelar', 'parar', 'stop', 'sair'].includes(entradaCobra)) {
                                if (!jogoCobra) return await sock.sendMessage(remoteJid, { text: 'ℹ️ Não há partida da cobrinha ativa neste grupo.' }, { quoted: m });
                                if (normalizarJid(jogoCobra.criador) !== normalizarJid(senderCanonico) && !souDono && !(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                    return await sock.sendMessage(remoteJid, { text: '❌ Só quem iniciou a cobrinha, um administrador ou o dono pode encerrar a partida.' }, { quoted: m });
                                }
                                jogosCobrinha.delete(remoteJid);
                                return await sock.sendMessage(remoteJid, { text: `🛑 Cobrinha encerrada. Pontuação final: *${jogoCobra.pontos}*.` }, { quoted: m });
                            }
                            if (jogoCobra && normalizarJid(jogoCobra.criador) !== normalizarJid(senderCanonico)) {
                                return await sock.sendMessage(remoteJid, { text: `🐍 Já existe uma cobrinha ativa neste grupo, controlada por @${normalizarJid(jogoCobra.criador)}. Só essa pessoa pode mover a cobrinha até a partida acabar.`, mentions: [jogoCobra.criador] }, { quoted: m });
                            }
                            if (!jogoCobra) {
                                if (jogosCobrinha.size >= MAX_MINIGAMES_POR_GRUPOS) podarMinigamesExpirados();
                                const cobraInicial = [{ x: 3, y: 3 }, { x: 2, y: 3 }, { x: 1, y: 3 }];
                                jogoCobra = { cobra: cobraInicial, fruta: { x: 5, y: 1 }, pontos: 0, criadoEm: Date.now(), ultimoMovimento: Date.now(), criador: senderCanonico };
                                if (cobraInicial.some(p => p.x === jogoCobra.fruta.x && p.y === jogoCobra.fruta.y)) jogoCobra.fruta = sortearFrutaCobrinha(cobraInicial);
                                jogosCobrinha.set(remoteJid, jogoCobra);
                                return await sock.sendMessage(remoteJid, { text: `🐍 *JOGO DA COBRINHA*\n\n${renderizarTabuleiroCobrinha(jogoCobra)}\n🍎 Pegue a maçã sem bater na parede ou no próprio corpo.\n\nMova com *${prefix}cobra cima*, *${prefix}cobra baixo*, *${prefix}cobra esquerda* ou *${prefix}cobra direita*.\nPara encerrar: *${prefix}cobra parar*.\n_Partida individual; expira após 10 minutos sem jogar._` }, { quoted: m });
                            }
                            if (!entradaCobra) {
                                return await sock.sendMessage(remoteJid, { text: `🐍 *COBRINHA — ${jogoCobra.pontos} ponto(s)*\n\n${renderizarTabuleiroCobrinha(jogoCobra)}\nUse *${prefix}cobra cima/baixo/esquerda/direita* para continuar.\nPara encerrar: *${prefix}cobra parar*.` }, { quoted: m });
                            }
                            const direcoesCobra = {
                                cima: { x: 0, y: -1 }, up: { x: 0, y: -1 }, norte: { x: 0, y: -1 },
                                baixo: { x: 0, y: 1 }, down: { x: 0, y: 1 }, sul: { x: 0, y: 1 },
                                esquerda: { x: -1, y: 0 }, left: { x: -1, y: 0 }, oeste: { x: -1, y: 0 },
                                direita: { x: 1, y: 0 }, right: { x: 1, y: 0 }, leste: { x: 1, y: 0 }
                            };
                            const direcaoCobra = direcoesCobra[entradaCobra];
                            if (!direcaoCobra) {
                                return await sock.sendMessage(remoteJid, { text: `🐍 Use *${prefix}cobra* para ver o tabuleiro, *${prefix}cobra cima/baixo/esquerda/direita* para se mover, ou *${prefix}cobra parar* para encerrar.` }, { quoted: m });
                            }
                            const cabecaCobra = jogoCobra.cobra[0];
                            const novaCabecaCobra = { x: cabecaCobra.x + direcaoCobra.x, y: cabecaCobra.y + direcaoCobra.y };
                            const comeuFrutaCobra = Boolean(jogoCobra.fruta && novaCabecaCobra.x === jogoCobra.fruta.x && novaCabecaCobra.y === jogoCobra.fruta.y);
                            const corpoVerificado = comeuFrutaCobra ? jogoCobra.cobra : jogoCobra.cobra.slice(0, -1);
                            const bateuParedeCobra = novaCabecaCobra.x < 0 || novaCabecaCobra.y < 0 || novaCabecaCobra.x >= TAMANHO_TABULEIRO_COBRINHA || novaCabecaCobra.y >= TAMANHO_TABULEIRO_COBRINHA;
                            const bateuCorpoCobra = corpoVerificado.some(p => p.x === novaCabecaCobra.x && p.y === novaCabecaCobra.y);
                            if (bateuParedeCobra || bateuCorpoCobra) {
                                jogosCobrinha.delete(remoteJid);
                                return await sock.sendMessage(remoteJid, { text: `💥 *FIM DE JOGO!* A cobrinha bateu.\n\n${renderizarTabuleiroCobrinha(jogoCobra)}\n🏆 Pontuação: *${jogoCobra.pontos}* ponto(s).\nComece outra com *${prefix}cobra*.` }, { quoted: m });
                            }
                            jogoCobra.cobra.unshift(novaCabecaCobra);
                            if (comeuFrutaCobra) {
                                jogoCobra.pontos++;
                                jogoCobra.fruta = sortearFrutaCobrinha(jogoCobra.cobra);
                            } else {
                                jogoCobra.cobra.pop();
                            }
                            jogoCobra.ultimoMovimento = Date.now();
                            if (!jogoCobra.fruta) {
                                jogosCobrinha.delete(remoteJid);
                                return await sock.sendMessage(remoteJid, { text: `🏆 *VOCÊ VENCEU!* Preencheu todo o tabuleiro da cobrinha com *${jogoCobra.pontos}* pontos!` }, { quoted: m });
                            }
                            return await sock.sendMessage(remoteJid, { text: `🐍 *COBRINHA — ${jogoCobra.pontos} ponto(s)*\n\n${renderizarTabuleiroCobrinha(jogoCobra)}\n${comeuFrutaCobra ? '🍎 Você pegou a maçã! +1 ponto.' : 'Use os comandos de direção para continuar.'}\n_Movimento: ${entradaCobra}_` }, { quoted: m });
                        }

                        case 'quiz': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '🧠 O quiz só funciona em grupos.' }, { quoted: m });
                            podarMinigamesExpirados();
                            const respostaQuizDigitada = String(textArgs || '').trim();
                            const respostaQuizNormalizada = normalizarRespostaQuiz(respostaQuizDigitada);
                            let jogoQuiz = jogosQuiz.get(remoteJid);
                            if (['cancelar', 'parar', 'stop'].includes(respostaQuizNormalizada)) {
                                if (!jogoQuiz) return await sock.sendMessage(remoteJid, { text: 'ℹ️ Não há quiz ativo neste grupo.' }, { quoted: m });
                                if (normalizarJid(jogoQuiz.criador) !== normalizarJid(senderCanonico) && !souDono && !(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                    return await sock.sendMessage(remoteJid, { text: '❌ Só quem iniciou o quiz, um administrador ou o dono pode encerrá-lo.' }, { quoted: m });
                                }
                                jogosQuiz.delete(remoteJid);
                                return await sock.sendMessage(remoteJid, { text: `🛑 Quiz encerrado. A resposta era: *${jogoQuiz.pergunta.respostas[0]}*.` }, { quoted: m });
                            }
                            if (!jogoQuiz || Date.now() - jogoQuiz.criadoEm > TTL_QUIZ_MS) {
                                if (jogoQuiz) jogosQuiz.delete(remoteJid);
                                const disponiveisQuiz = BANCO_QUIZ_ARLEY.filter(q => q.pergunta !== jogoQuiz?.pergunta?.pergunta);
                                const perguntaQuiz = disponiveisQuiz[Math.floor(Math.random() * disponiveisQuiz.length)] || BANCO_QUIZ_ARLEY[0];
                                jogoQuiz = { pergunta: perguntaQuiz, criadoEm: Date.now(), criador: senderCanonico, tentativas: 0 };
                                if (jogosQuiz.size >= MAX_MINIGAMES_POR_GRUPOS) podarMinigamesExpirados();
                                jogosQuiz.set(remoteJid, jogoQuiz);
                                return await sock.sendMessage(remoteJid, { text: `🧠 *QUIZ RELÂMPAGO*\n\n❓ ${perguntaQuiz.pergunta}\n\nO primeiro participante a acertar ganha!\nResponda com *${prefix}quiz sua resposta*.\nPara encerrar: *${prefix}quiz parar*.\n⏳ A pergunta expira em 3 minutos.` }, { quoted: m });
                            }
                            if (!respostaQuizDigitada) {
                                return await sock.sendMessage(remoteJid, { text: `🧠 Pergunta ativa: *${jogoQuiz.pergunta.pergunta}*\nResponda com *${prefix}quiz sua resposta*.` }, { quoted: m });
                            }
                            jogoQuiz.tentativas++;
                            const respostasCorretasQuiz = jogoQuiz.pergunta.respostas.map(normalizarRespostaQuiz);
                            if (respostasCorretasQuiz.includes(respostaQuizNormalizada)) {
                                jogosQuiz.delete(remoteJid);
                                return await sock.sendMessage(remoteJid, { text: `🏆 *RESPOSTA CERTA!*\n\n@${normalizarJid(senderCanonico)} venceu o quiz! 🎉\n🧠 Resposta: *${jogoQuiz.pergunta.respostas[0]}*\n📊 Tentativas no grupo: ${jogoQuiz.tentativas}.`, mentions: [senderCanonico] }, { quoted: m });
                            }
                            const respostaCertaQuiz = jogoQuiz.pergunta.respostas[0];
                            const dicaQuiz = respostaCertaQuiz.length > 2 ? `Dica: começa com *${respostaCertaQuiz[0].toUpperCase()}* e tem *${respostaCertaQuiz.length}* letras.` : 'Tente outra resposta.';
                            return await sock.sendMessage(remoteJid, { text: `❌ Ainda não! ${dicaQuiz}` }, { quoted: m });
                        }

                        case 'configgrupo':
                        case 'configurargrupo':
                        case 'painelgrupo': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Este painel só funciona dentro de um grupo.' }, { quoted: m });
                            const aluguelGrupo = dadosGlobais.statusAluguelGrupos?.[remoteJid] || 'não cadastrado';
                            const prefixGrupoAtual = obterPrefixoChat(remoteJid);
                            const antiSpamGrupo = gruposAntiSpamAtivo.has(remoteJid) ? '✅ Ativado' : '❌ Desativado';
                            const brincadeirasGrupo = dadosGlobais.brincadeiras?.[remoteJid] ? '✅ Ativadas' : '❌ Desativadas';
                            const avisosGrupo = dadosGlobais.gruposAvisos?.[remoteJid] ? '✅ Ativados' : '❌ Desativados';
                            const bemVindoGrupo = dadosGlobais.bemVindoGrupos?.[remoteJid] === true ? '✅ Ativado' : '❌ Desativado';
                            const nfswGrupo = dadosGlobais.nfsw1Grupos?.[remoteJid] ? '✅ Ativado' : '🔒 Desativado';
                            const antipornoGrupo = dadosGlobais.antiPornoGrupos?.[remoteJid] ? '🛑 Ativado' : '✅ Desativado';
                            const painelConfigGrupo = `⚙️ *CONFIGURAÇÕES DESTE GRUPO*\n\n` +
                                `💳 *Aluguel:* ${aluguelGrupo}\n` +
                                `⌨️ *Prefixo:* \`${prefixGrupoAtual}\`\n` +
                                `🛡️ *Anti-spam:* ${antiSpamGrupo}\n` +
                                `🎉 *Brincadeiras/economia:* ${brincadeirasGrupo}\n` +
                                `📢 *Avisos:* ${avisosGrupo}\n` +
                                `👋 *Boas-vindas:* ${bemVindoGrupo}\n` +
                                `🖼️ *NFSW:* ${nfswGrupo}\n` +
                                `🚫 *Antiporno local:* ${antipornoGrupo}\n\n` +
                                `Administradores: *${prefixGrupoAtual}prefixo !* altera o prefixo, *${prefixGrupoAtual}antispam on/off* configura o antispam e *${prefixGrupoAtual}bem-vindo 1/0* controla as boas-vindas.\n` +
                                `Essas opções são específicas deste grupo.`;
                            return await sock.sendMessage(remoteJid, { text: painelConfigGrupo }, { quoted: m });
                        }

                        case 'bem-vindo':
                        case 'bemvindo': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona dentro de um grupo.' }, { quoted: m });
                            const valorBemVindo = String(textArgs || '').trim();
                            if (valorBemVindo !== '1' && valorBemVindo !== '0') {
                                const estadoAtual = dadosGlobais.bemVindoGrupos?.[remoteJid] === true ? 'ATIVADO ✅' : 'DESATIVADO ❌';
                                return await sock.sendMessage(remoteJid, {
                                    text: `👋 *BOAS-VINDAS DO GRUPO*\n\nEstado atual: *${estadoAtual}*\n\nUse *${prefix}bem-vindo 1* para ativar.\nUse *${prefix}bem-vindo 0* para desativar.\n\nQuando alguém entrar, o bot enviará a foto de perfil da pessoa com uma legenda marcando-a e mostrando o nome do grupo. A descrição do grupo não será exibida.`
                                }, { quoted: m });
                            }
                            if (!dadosGlobais.bemVindoGrupos || typeof dadosGlobais.bemVindoGrupos !== 'object') dadosGlobais.bemVindoGrupos = {};
                            dadosGlobais.bemVindoGrupos[remoteJid] = valorBemVindo === '1';
                            await salvarDadosBot(dadosGlobais);
                            return await sock.sendMessage(remoteJid, {
                                text: valorBemVindo === '1'
                                    ? '✅ Boas-vindas ativadas neste grupo. Quando alguém entrar, o ArleyBot enviará a foto de perfil com uma legenda, marcará a pessoa e mostrará o nome do grupo.'
                                    : '✅ Boas-vindas desativadas neste grupo.'
                            }, { quoted: m });
                        }

                        case 'morrer': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ O comando .morrer só funciona dentro de um grupo.' }, { quoted: m });
                            if (!(await isAdminGrupo(remoteJid, normalizarJid(getBotJid()), false))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Para executar .morrer, o ArleyBot precisa ser administrador do grupo.' }, { quoted: m });
                            }

                            const metaMorrer = await obterMetadadosGrupoComTimeout(remoteJid, 8000);
                            const idsAlvoMorrer = [senderCanonico, sender, m.key?.participant].filter(Boolean).map(String);
                            const registroAlvoMorrer = (metaMorrer?.participants || []).find(p => {
                                const ids = [p?.id, p?.jid, p?.phoneNumber, p?.lid].filter(Boolean).map(String);
                                return idsAlvoMorrer.some(alvo => ids.includes(alvo) || ids.some(id => normalizarJid(id) === normalizarJid(alvo)));
                            });
                            const jidAlvoMorrer = registroAlvoMorrer?.phoneNumber || registroAlvoMorrer?.jid || registroAlvoMorrer?.id || senderCanonico;
                            if (!jidAlvoMorrer || normalizarJid(jidAlvoMorrer) === normalizarJid(getBotJid())) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Não consegui identificar a pessoa que enviou o comando.' }, { quoted: m });
                            }

                            await sock.sendMessage(remoteJid, {
                                text: `💀 *JÁ FOI TARDE!* @${normalizarJid(jidAlvoMorrer)}, vou te tirar daqui por 5 segundos... 😈`,
                                mentions: [jidAlvoMorrer]
                            }, { quoted: m });

                            try {
                                const resultadoRemoverMorrer = await sock.groupParticipantsUpdate(remoteJid, [jidAlvoMorrer], 'remove');
                                const erroStatusRemover = Array.isArray(resultadoRemoverMorrer) ? resultadoRemoverMorrer.find(r => r?.status && !['200', 'ok', 'success'].includes(String(r.status).toLowerCase())) : null;
                                if (erroStatusRemover) throw new Error(`WhatsApp retornou status ${erroStatusRemover.status}`);
                            } catch (erroRemoverMorrer) {
                                console.warn('[MORRER] Não consegui remover temporariamente o participante:', erroRemoverMorrer?.message || erroRemoverMorrer);
                                return await sock.sendMessage(remoteJid, { text: '❌ Não consegui remover você temporariamente. Confira se o ArleyBot é administrador e se você não tem um nível de administração que impeça a remoção.' }, { quoted: m });
                            }

                            const timerRetornoMorrer = setTimeout(async () => {
                                try {
                                    const resultadoAdicionarMorrer = await sock.groupParticipantsUpdate(remoteJid, [jidAlvoMorrer], 'add');
                                    const erroStatusAdicionar = Array.isArray(resultadoAdicionarMorrer) ? resultadoAdicionarMorrer.find(r => r?.status && !['200', 'ok', 'success'].includes(String(r.status).toLowerCase())) : null;
                                    if (erroStatusAdicionar) throw new Error(`WhatsApp retornou status ${erroStatusAdicionar.status}`);

                                    const chaveConfirmacaoMorrer = `${remoteJid}|${normalizarJid(jidAlvoMorrer)}`;
                                    const tokenConfirmacaoMorrer = `${Date.now()}-${normalizarJid(jidAlvoMorrer)}`;
                                    const timerExpiracaoMorrer = setTimeout(() => {
                                        const estadoAtual = confirmacoesMorrer.get(chaveConfirmacaoMorrer);
                                        if (estadoAtual?.token === tokenConfirmacaoMorrer) confirmacoesMorrer.delete(chaveConfirmacaoMorrer);
                                    }, 2 * 60 * 1000);
                                    timerExpiracaoMorrer.unref?.();
                                    const anteriorConfirmacaoMorrer = confirmacoesMorrer.get(chaveConfirmacaoMorrer);
                                    if (anteriorConfirmacaoMorrer?.timer) clearTimeout(anteriorConfirmacaoMorrer.timer);
                                    confirmacoesMorrer.set(chaveConfirmacaoMorrer, {
                                        participante: jidAlvoMorrer,
                                        expiraEm: Date.now() + 2 * 60 * 1000,
                                        token: tokenConfirmacaoMorrer,
                                        timer: timerExpiracaoMorrer
                                    });
                                    while (confirmacoesMorrer.size > 500) {
                                        const chaveMaisAntiga = confirmacoesMorrer.keys().next().value;
                                        const registroAntigo = confirmacoesMorrer.get(chaveMaisAntiga);
                                        if (registroAntigo?.timer) clearTimeout(registroAntigo.timer);
                                        confirmacoesMorrer.delete(chaveMaisAntiga);
                                    }

                                    await enviarBotoesWhatsApp(remoteJid,
                                        `🤔 @${normalizarJid(jidAlvoMorrer)}, você realmente queria sair do grupo?\n\nEscolha uma opção abaixo. Se não responder em 2 minutos, a pergunta expira.`,
                                        [
                                            { id: `${prefix}morrer_sim`, text: '✅ Sim, quero sair' },
                                            { id: `${prefix}morrer_nao`, text: '❌ Não, quero ficar' }
                                        ],
                                        { mentions: [jidAlvoMorrer] }
                                    );
                                } catch (erroAdicionarMorrer) {
                                    console.warn('[MORRER] Não consegui readicionar o participante:', erroAdicionarMorrer?.message || erroAdicionarMorrer);
                                    await sock.sendMessage(remoteJid, {
                                        text: `⚠️ Não consegui readicionar @${normalizarJid(jidAlvoMorrer)} automaticamente. O WhatsApp pode exigir um convite ou aprovação de entrada.`,
                                        mentions: [jidAlvoMorrer]
                                    }).catch(() => {});
                                }
                            }, 5000);
                            timerRetornoMorrer.unref?.();
                            return;
                        }

                        case 'morrer_sim': {
                            if (!isGroup) return;
                            const chaveConfirmacaoMorrer = `${remoteJid}|${cleanSender}`;
                            const confirmacaoMorrer = confirmacoesMorrer.get(chaveConfirmacaoMorrer);
                            if (!confirmacaoMorrer || confirmacaoMorrer.expiraEm <= Date.now()) {
                                if (confirmacaoMorrer?.timer) clearTimeout(confirmacaoMorrer.timer);
                                confirmacoesMorrer.delete(chaveConfirmacaoMorrer);
                                return await sock.sendMessage(remoteJid, { text: '⌛ Essa confirmação expirou. Use .morrer novamente se ainda quiser sair.' }, { quoted: m });
                            }
                            if (confirmacaoMorrer.timer) clearTimeout(confirmacaoMorrer.timer);
                            confirmacoesMorrer.delete(chaveConfirmacaoMorrer);
                            await sock.sendMessage(remoteJid, {
                                text: `🚪 @${normalizarJid(confirmacaoMorrer.participante)} confirmou que quer sair do grupo.`,
                                mentions: [confirmacaoMorrer.participante]
                            });
                            try {
                                const resultadoRemocaoFinal = await sock.groupParticipantsUpdate(remoteJid, [confirmacaoMorrer.participante], 'remove');
                                const erroStatusFinal = Array.isArray(resultadoRemocaoFinal) ? resultadoRemocaoFinal.find(r => r?.status && !['200', 'ok', 'success'].includes(String(r.status).toLowerCase())) : null;
                                if (erroStatusFinal) throw new Error(`WhatsApp retornou status ${erroStatusFinal.status}`);
                            } catch (erroSaidaConfirmada) {
                                console.warn('[MORRER] A saída confirmada falhou:', erroSaidaConfirmada?.message || erroSaidaConfirmada);
                                return await sock.sendMessage(remoteJid, { text: '❌ Você confirmou a saída, mas não consegui remover você. Verifique as permissões administrativas do ArleyBot.' }, { quoted: m });
                            }
                            return;
                        }

                        case 'morrer_nao': {
                            if (!isGroup) return;
                            const chaveConfirmacaoMorrer = `${remoteJid}|${cleanSender}`;
                            const confirmacaoMorrer = confirmacoesMorrer.get(chaveConfirmacaoMorrer);
                            if (!confirmacaoMorrer || confirmacaoMorrer.expiraEm <= Date.now()) {
                                if (confirmacaoMorrer?.timer) clearTimeout(confirmacaoMorrer.timer);
                                confirmacoesMorrer.delete(chaveConfirmacaoMorrer);
                                return await sock.sendMessage(remoteJid, { text: '⌛ Essa confirmação expirou. Você permanece no grupo.' }, { quoted: m });
                            }
                            if (confirmacaoMorrer.timer) clearTimeout(confirmacaoMorrer.timer);
                            confirmacoesMorrer.delete(chaveConfirmacaoMorrer);
                            return await sock.sendMessage(remoteJid, {
                                text: `✅ Beleza, @${normalizarJid(confirmacaoMorrer.participante)}! Você continua no grupo. 😄`,
                                mentions: [confirmacaoMorrer.participante]
                            }, { quoted: m });
                        }

                        case 'status':
                        case 'painelbot': {
                            const mem = process.memoryUsage();
                            const formatarBytes = valor => `${(Number(valor || 0) / (1024 * 1024)).toFixed(1)} MiB`;
                            const tempoLigado = Math.floor(process.uptime());
                            const dias = Math.floor(tempoLigado / 86400);
                            const horas = Math.floor((tempoLigado % 86400) / 3600);
                            const minutos = Math.floor((tempoLigado % 3600) / 60);
                            const segundos = tempoLigado % 60;
                            const statusConexao = socketAberto ? '🟢 Conectado' : '🟠 Reconectando/indisponível';
                            const conversoesNaFila = contarConversoesNaFila();
                            const antiSpamAtual = isGroup && gruposAntiSpamAtivo.has(remoteJid) ? 'ativado' : 'desativado';
                            const statusTexto = `🖥️ *PAINEL DE SAÚDE — ARLEYBOT ${ARLEYBOT_VERSION}*\n\n` +
                                `🔌 *WhatsApp:* ${statusConexao}\n` +
                                `⏱️ *Tempo ligado:* ${dias}d ${horas}h ${minutos}m ${segundos}s\n` +
                                `🧠 *RAM (RSS):* ${formatarBytes(mem.rss)}\n` +
                                `📦 *Heap JS:* ${formatarBytes(mem.heapUsed)} / ${formatarBytes(mem.heapTotal)}\n` +
                                `📨 *Mensagens em processamento:* ${mensagensEmProcessamento}\n` +
                                `🎞️ *Conversões pesadas:* ${conversoesPesadasAtivas}/${LIMITE_CONVERSOES_PESADAS} ativas\n` +
                                `🕒 *Conversões aguardando:* ${conversoesNaFila}\n` +
                                `📚 *Fila de comandos:* ${filaComandosMensagens.length} | fila normal: ${filaNormalMensagens.length}\n` +
                                `${isGroup ? `🛡️ *Anti-spam deste grupo:* ${antiSpamAtual}\n` : ''}` +
                                `${isGroup ? `⌨️ *Prefixo deste grupo:* \`${prefix}\`\n` : ''}` +
                                `🧹 *Limpeza de temporários:* arquivos com mais de 24h são removidos gradualmente.`;
                            await sock.sendMessage(remoteJid, { text: statusTexto }, { quoted: m });
                            if (isGroup && await isAdminGrupo(remoteJid, cleanSender, souDono)) {
                                let nomeGrupoPainel = 'este grupo';
                                try {
                                    nomeGrupoPainel = String((await obterMetadadosGrupoComTimeout(remoteJid))?.subject || nomeGrupoPainel).slice(0, 80);
                                } catch (_) {}
                                return await enviarBotoesWhatsApp(remoteJid,
                                    `⚙️ *PAINEL DE ADMINISTRAÇÃO DO GRUPO*\n\nO que você deseja fazer em *${nomeGrupoPainel}*?\n\nEscolha uma ação abaixo. Para alterar a foto, use *${prefix}icon GP* respondendo à imagem desejada.`,
                                    [
                                        { id: `${prefix}admgrupo fechar`, text: '🔒 Fechar grupo' },
                                        { id: `${prefix}admgrupo abrir`, text: '🔓 Abrir grupo' },
                                        { id: `${prefix}admgrupo mais`, text: '⚙️ Mais opções' }
                                    ], { quoted: m });
                            }
                            return;
                        }

                        case 'admgrupo': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ O painel administrativo só funciona dentro de um grupo.' }, { quoted: m });
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores do grupo ou o dono do bot podem usar este painel.' }, { quoted: m });
                            }
                            const acaoAdmGrupo = String(args[0] || '').trim().toLowerCase();
                            const textoAdmGrupo = args.slice(1).join(' ').trim();
                            if (['mais', 'opcoes', 'opções', 'editar', 'menu'].includes(acaoAdmGrupo)) {
                                return await enviarBotoesWhatsApp(remoteJid,
                                    `🛠️ *MAIS CONFIGURAÇÕES DO GRUPO*\n\nEscolha o que deseja editar. Para trocar a foto, responda à imagem escolhida com *${prefix}icon GP*.`,
                                    [
                                        { id: `${prefix}admgrupo nome`, text: '✏️ Alterar nome' },
                                        { id: `${prefix}admgrupo descricao`, text: '📝 Alterar descrição' },
                                        { id: `${prefix}admgrupo foto`, text: '🖼️ Trocar foto' }
                                    ], { quoted: m });
                            }
                            if (['fechar', 'close'].includes(acaoAdmGrupo)) {
                                if (!(await botEhAdminGrupo(remoteJid))) return await sock.sendMessage(remoteJid, { text: '❌ Para fechar o grupo por comando, o próprio ArleyBot também precisa ser administrador.' }, { quoted: m });
                                await sock.groupSettingUpdate(remoteJid, 'announcement');
                                return await sock.sendMessage(remoteJid, { text: '🔒 Grupo fechado! Agora somente administradores podem enviar mensagens.' }, { quoted: m });
                            }
                            if (['abrir', 'open'].includes(acaoAdmGrupo)) {
                                if (!(await botEhAdminGrupo(remoteJid))) return await sock.sendMessage(remoteJid, { text: '❌ Para abrir o grupo por comando, o próprio ArleyBot também precisa ser administrador.' }, { quoted: m });
                                await sock.groupSettingUpdate(remoteJid, 'not_announcement');
                                return await sock.sendMessage(remoteJid, { text: '🔓 Grupo aberto! Todos os participantes podem enviar mensagens.' }, { quoted: m });
                            }
                            if (['nome', 'assunto', 'titulo', 'título'].includes(acaoAdmGrupo)) {
                                if (!textoAdmGrupo) return await sock.sendMessage(remoteJid, { text: `✏️ Para mudar o nome, envie *${prefix}admgrupo nome Novo nome do grupo*.` }, { quoted: m });
                                if (textoAdmGrupo.length > 100) return await sock.sendMessage(remoteJid, { text: '❌ O nome do grupo precisa ter até 100 caracteres.' }, { quoted: m });
                                if (!(await botEhAdminGrupo(remoteJid))) return await sock.sendMessage(remoteJid, { text: '❌ Para alterar o nome do grupo por comando, o próprio ArleyBot também precisa ser administrador.' }, { quoted: m });
                                await sock.groupUpdateSubject(remoteJid, textoAdmGrupo);
                                return await sock.sendMessage(remoteJid, { text: `✅ Nome do grupo alterado para: *${textoAdmGrupo}*` }, { quoted: m });
                            }
                            if (['descricao', 'descrição', 'desc', 'texto'].includes(acaoAdmGrupo)) {
                                if (!textoAdmGrupo) return await sock.sendMessage(remoteJid, { text: `📝 Para mudar a descrição, envie *${prefix}admgrupo descricao Novo texto da descrição*. Para limpar, use *${prefix}admgrupo descricao limpar*.` }, { quoted: m });
                                const novaDescricao = ['limpar', 'apagar', 'vazio'].includes(textoAdmGrupo.toLowerCase()) ? '' : textoAdmGrupo;
                                if (novaDescricao.length > 2048) return await sock.sendMessage(remoteJid, { text: '❌ A descrição ficou grande demais. Reduza o texto e tente novamente.' }, { quoted: m });
                                if (!(await botEhAdminGrupo(remoteJid))) return await sock.sendMessage(remoteJid, { text: '❌ Para alterar a descrição do grupo por comando, o próprio ArleyBot também precisa ser administrador.' }, { quoted: m });
                                await sock.groupUpdateDescription(remoteJid, novaDescricao);
                                return await sock.sendMessage(remoteJid, { text: novaDescricao ? '✅ Descrição do grupo alterada!' : '✅ Descrição do grupo removida.' }, { quoted: m });
                            }
                            if (['foto', 'imagem', 'icon'].includes(acaoAdmGrupo)) {
                                return await sock.sendMessage(remoteJid, { text: `🖼️ Para trocar a foto do grupo, envie/responda à imagem desejada com *${prefix}icon GP*. Apenas administradores podem fazer isso.` }, { quoted: m });
                            }
                            return await sock.sendMessage(remoteJid, { text: `⚙️ *PAINEL DO GRUPO*\nUse os botões de *.status* ou estes comandos:\n• *${prefix}admgrupo fechar*\n• *${prefix}admgrupo abrir*\n• *${prefix}admgrupo nome Novo nome*\n• *${prefix}admgrupo descricao Novo texto*\n• Responda a uma imagem com *${prefix}icon GP* para mudar a foto.` }, { quoted: m });
                        }

                        case 'icon': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ O comando .icon GP só funciona dentro de grupos.' }, { quoted: m });
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores do grupo ou o dono do bot podem trocar a foto.' }, { quoted: m });
                            }
                            if (String(args[0] || '').trim().toUpperCase() !== 'GP') {
                                return await sock.sendMessage(remoteJid, { text: `🖼️ Para trocar a foto do grupo, responda à imagem desejada com *${prefix}icon GP*.` }, { quoted: m });
                            }
                            if (!(await botEhAdminGrupo(remoteJid))) return await sock.sendMessage(remoteJid, { text: '❌ Para trocar a foto do grupo por comando, o próprio ArleyBot também precisa ser administrador.' }, { quoted: m });
                            const mediaIconGrupo = getTargetMedia(corpoMsg);
                            if (!mediaIconGrupo || mediaIconGrupo.type !== 'image') {
                                return await sock.sendMessage(remoteJid, { text: `📸 Envie uma foto ou responda à foto desejada com *${prefix}icon GP*. Por segurança, são aceitas apenas imagens de até 10 MiB.` }, { quoted: m });
                            }
                            let bufferIconGrupo;
                            try {
                                const streamIconGrupo = await downloadContentFromMessage(mediaIconGrupo.msg, 'image');
                                bufferIconGrupo = await streamParaBufferLimitado(streamIconGrupo, 10 * 1024 * 1024, 'foto do grupo');
                                if (!bufferIconGrupo.length) throw new Error('A imagem recebida está vazia.');
                                await sock.updateProfilePicture(remoteJid, bufferIconGrupo);
                                return await sock.sendMessage(remoteJid, { text: '✅ Foto do grupo atualizada com sucesso!' }, { quoted: m });
                            } catch (erroIconGrupo) {
                                const detalheIconGrupo = String(erroIconGrupo?.message || erroIconGrupo || 'erro desconhecido');
                                console.error('[ICON GP] Falha ao atualizar a foto do grupo:', detalheIconGrupo);
                                return await sock.sendMessage(remoteJid, { text: /ultrapassou o limite/i.test(detalheIconGrupo) ? '❌ A imagem ultrapassou 10 MiB. Envie uma foto menor para proteger a memória do celular.' : `❌ Não consegui atualizar a foto do grupo. Confira se o ArleyBot é administrador e tente uma imagem JPEG, PNG ou WebP menor.\nDetalhe: ${detalheIconGrupo.slice(0, 250)}` }, { quoted: m });
                            } finally {
                                bufferIconGrupo = null;
                            }
                        }

                        case 'prefixo': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ O prefixo personalizado só pode ser configurado dentro de um grupo.' }, { quoted: m });
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores do grupo ou o dono podem alterar o prefixo.' }, { quoted: m });
                            }
                            const valorPrefixo = String(textArgs || '').trim();
                            if (!valorPrefixo) {
                                return await sock.sendMessage(remoteJid, { text: `⌨️ *Prefixo atual:* \`${prefix}\`\nUse *${prefix}prefixo !* para trocar por !.\nUse *${prefix}prefixo .* para voltar ao padrão.` }, { quoted: m });
                            }
                            if (!dadosGlobais.prefixosGrupos || typeof dadosGlobais.prefixosGrupos !== 'object') dadosGlobais.prefixosGrupos = {};
                            if (['padrao', 'padrão', 'default', 'reset'].includes(valorPrefixo.toLowerCase())) {
                                delete dadosGlobais.prefixosGrupos[remoteJid];
                                await salvarDadosBot(dadosGlobais);
                                return await sock.sendMessage(remoteJid, { text: '✅ Prefixo padrão restaurado: os próximos comandos começam com ponto (.).' }, { quoted: m });
                            }
                            const novoPrefixo = validarPrefixoPersonalizado(valorPrefixo);
                            if (!novoPrefixo) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Prefixo inválido. Use de 1 a 3 símbolos sem espaços nem letras/números. Exemplos: !, #, !! ou /' }, { quoted: m });
                            }
                            dadosGlobais.prefixosGrupos[remoteJid] = novoPrefixo;
                            await salvarDadosBot(dadosGlobais);
                            return await sock.sendMessage(remoteJid, { text: `✅ Prefixo deste grupo alterado para *${novoPrefixo}*\nA partir de agora, os comandos precisam usar esse prefixo. Exemplo: *${novoPrefixo}menu*. O ponto deixa de funcionar neste grupo até você restaurar o padrão.` }, { quoted: m });
                        }

                        case 'reportarbug': {
                            const mediaBug = getMediaMessage(corpoMsg);
                            const mediaImagemBug = mediaBug?.type === 'image' ? mediaBug : null;
                            const descricaoBug = String(textArgs || '').trim().slice(0, 2500);
                            if (!descricaoBug && !mediaImagemBug) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `🐞 *REPORTAR BUG*\nUse *${prefix}reportarbug <descrição>* para enviar o relato agora.\n\nTambém pode responder a uma foto do erro com *${prefix}reportarbug <descrição>*; a foto e a descrição serão enviadas ao dono.`
                                }, { quoted: m });
                            }
                            const numeroDonoBug = String(dadosGlobais.numeroDono || '').replace(/\D/g, '');
                            if (numeroDonoBug.length < 8) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Não consegui identificar o contato do dono para encaminhar o relato. Avise o administrador do bot.' }, { quoted: m });
                            }
                            const jidDonoBug = `${numeroDonoBug}@s.whatsapp.net`;
                            const origemBug = isGroup ? `Grupo ${remoteJid}` : 'conversa privada';
                            const nomeReporterBug = String(m.pushName || cleanSender || 'usuário').replace(/[\r\n]+/g, ' ').slice(0, 80);
                            const cabecalhoBug = `🐞 *NOVO RELATO DE BUG — ARLEYBOT ${ARLEYBOT_VERSION}*\n` +
                                `👤 De: ${nomeReporterBug} (${cleanSender})\n` +
                                `💬 Origem: ${origemBug}\n` +
                                `🕒 Recebido: ${new Date().toISOString()}\n\n`;
                            let fotoEnviadaBug = false;
                            let falhaFotoBug = '';
                            if (mediaImagemBug) {
                                try {
                                    const streamBug = await downloadContentFromMessage(mediaImagemBug.msg, 'image');
                                    const bufferBug = await streamParaBufferLimitado(streamBug, 12 * 1024 * 1024, 'foto do relatório de bug');
                                    if (!bufferBug.length) throw new Error('A foto veio vazia.');
                                    const legendaBug = `${cabecalhoBug}📝 Descrição: ${descricaoBug || 'Foto enviada para mostrar o erro.'}`.slice(0, 1020);
                                    await sock.sendMessage(jidDonoBug, { image: bufferBug, mimetype: mediaImagemBug.msg.mimetype || 'image/jpeg', caption: legendaBug });
                                    fotoEnviadaBug = true;
                                } catch (erroFotoBug) {
                                    falhaFotoBug = `\n⚠️ A foto não foi anexada (${String(erroFotoBug?.message || erroFotoBug).slice(0, 160)}).`;
                                }
                            }
                            if (!fotoEnviadaBug) {
                                const textoBugDono = `${cabecalhoBug}📝 Descrição: ${descricaoBug || 'O usuário tentou anexar uma foto, mas ela não pôde ser transferida.'}${falhaFotoBug}`;
                                await sock.sendMessage(jidDonoBug, { text: textoBugDono.slice(0, 3500) });
                            }
                            const confirmacaoBug = `✅ Seu relato foi enviado ao dono do ArleyBot.\n${fotoEnviadaBug ? '📷 A foto foi anexada.' : '📝 O texto foi enviado.'}\n\nPara ajudar a reproduzir o erro, você também pode responder a uma foto/screenshot com *${prefix}reportarbug <descrição>*; o relato já enviado não precisa ser repetido.${falhaFotoBug}`;
                            return await sock.sendMessage(remoteJid, { text: confirmacaoBug }, { quoted: m });
                        }

                        case 'menu': {
                            const progressoMenu = await iniciarCarregamentoComando(remoteJid, m, 'Carregando menu principal', 'Organizando os comandos...');
                            const menuText = `
╭━━━ *ARLEYBOT V4* ━━━╮
┃ 🤖 *MENU DE COMANDOS*
┣━━━━━━━━━━━━━━━━━━
┃ 🐞 *${prefix}reportarbug <texto>* - Envia um relato de erro diretamente ao dono
┃    Aceita texto sozinho ou foto com a descrição do erro.
┃ 📊 *${prefix}status* / *${prefix}painelbot* - Saúde, RAM, filas e conversões
┃ ⚙️ *${prefix}configgrupo* - Configurações individuais do grupo
┃ ⌨️ *${prefix}prefixo <símbolo>* - Prefixo personalizado deste grupo (ADM)
┃ 👋 *${prefix}bem-vindo 1/0* - Ativa/desativa saudação com a foto de perfil
┃ 💀 *${prefix}morrer* - Brincadeira com confirmação de saída por botões
┃ 📌 *GERAL*
┃ 🔸 *${prefix}menu* - Mostra este menu
┃ 🔸 *${prefix}ping* - Testa conexão
┃ 🔸 *${prefix}log* - Novidades e estado
┃ 🔸 *${prefix}menunfsw* - Menu de imagens especiais (quando liberado pelo ADM)
┃ 🔸 *${prefix}nfsw 1* / *${prefix}nfsw 0* - Ativa/desativa imagens especiais (ADM)
┃ 🔸 *${prefix}ver* / *${prefix}sobre* - Sobre o bot
┃ 🔸 *${prefix}fixar* - Fixa mensagem marcada
┃
┃ 🎨 *MÍDIA*
┃ 🔸 *${prefix}f* / *${prefix}s* - Faz figurinha
┃ 🔸 *${prefix}achatar* - Achata foto, vídeo ou figurinha 😂
┃ 🔸 *${prefix}toimg* - Figurinha para imagem
┃ 🔸 *${prefix}tovideo* - Figurinha para vídeo
┃ 🔸 *${prefix}toaudio* - Extrai o áudio de um vídeo (MP3)
┃ 🔸 *${prefix}totag* - Repete a mensagem respondida e marca todos invisivelmente
┃ 🔸 *${prefix}marcar-todos* / *${prefix}tagall* - Marca todos
┃ 🔸 *${prefix}yt <nome>* / *${prefix}youtube <nome>* - Baixa áudio
┃ 🔸 *${prefix}link <URL>* - Baixa vídeo de até 340 segundos
┃ 🔸 *${prefix}cancelar* - Interrompe seu download ativo
┃
┃ 🧠 *INTELIGÊNCIA ARTIFICIAL*
┃ 🔸 *${prefix}gemini <texto>* - IA Google Gemini
┃ 🔸 *${prefix}gpt <texto>* - IA OpenAI GPT
┃ 🔸 *${prefix}grok <texto>* - IA xAI Grok
┃
┃ 🎉 *BRINCADEIRAS*
┃ 🔸 *${prefix}brincadeiras* - Brincadeira aleatória
┃ 🔸 *${prefix}brincadeira* - Brincadeira
┃ 🔸 *${prefix}maisgente* - Sorteio de pessoas
┃ 🔸 *${prefix}sorteiar <texto>* - Sorteia 5 integrantes sem repetir
┃ 🔸 *${prefix}velha [@pessoa/bot]* - Jogo da velha em grupo
┃ 🔸 *${prefix}jogar <1-9>* - Faz uma jogada da velha
┃ 🔸 *${prefix}adivinhar [1-20]* - Adivinha o número em grupo
┃ 🔸 *${prefix}cobra* - Jogo da cobrinha com comandos de direção
┃ 🔸 *${prefix}quiz* - Quiz relâmpago de conhecimentos gerais
┃ 🔸 *${prefix}petista* - Ranking aleatório de 5 integrantes (zoeira)
┃ 🔸 *${prefix}bolsonarista* - Ranking aleatório de 5 integrantes (zoeira)
┃ 🔸 *${prefix}genteboa* - Interação/brincadeira
┃ 🔸 *${prefix}traçar @pessoa* / *${prefix}traçar todos* - Brincadeira com GIF animado 😂
┃ 🔸 *${prefix}beijar @pessoa* / *${prefix}beijar todos* - Beijo com GIF animado 💋
┃ 🔸 *${prefix}tapa @pessoa* - Dá uma tapa de brincadeira com GIF aleatório 🫲💥
┃ 🔸 *${prefix}apostar <valor>* - Aposta
┃
┃ 💰 *ECONOMIA / BANCO*
┃ 🔸 *${prefix}brincadeiras1* / *${prefix}brincadeiras0* - Liga/desliga economia
┃ 🔸 *${prefix}cadastrarbanco* - Cadastra no Banco
┃ 🔸 *${prefix}desativarcada* - Remove cadastro
┃ 🔸 *${prefix}perfil [@pessoa]* - Perfil
┃ 🔸 *${prefix}rank dinheiro* - Ranking de dinheiro
┃ 🔸 *${prefix}rankrico* - Sorteia 5 cadastrados e mostra quem é o mais rico
┃ 🔸 *${prefix}rank nivel* - Ranking de nível
┃ 🔸 *${prefix}trabalhar* / *${prefix}work* - Trabalhar
┃ 🔸 *${prefix}comprarxp <valor>* - Comprar XP
┃ 🔸 *${prefix}roubar @pessoa* - Tentar roubar
┃ 🔸 *${prefix}daily* - Recompensa diária
┃ 🔸 *${prefix}missoes* - Missões diárias
┃ 🔸 *${prefix}conquistas* - Conquistas
┃ 🔸 *${prefix}loja* - Loja
┃ 🔸 *${prefix}comprar <item> [credito]* - Comprar item
┃ 🔸 *${prefix}pix @pessoa <valor>* - Transferir dinheiro
┃ 🔸 *${prefix}depositar <valor>* - Depositar na poupança
┃ 🔸 *${prefix}sacar <valor>* - Sacar da poupança
┃ 🔸 *${prefix}limite* - Ver limite de crédito
┃ 🔸 *${prefix}aumentarlimite* - Solicitar aumento do limite do cartão
┃ 🔸 *${prefix}emprestimo <valor>* - Solicitar empréstimo
┃ 🔸 *${prefix}pagaremprestimo <valor>* - Pagar empréstimo
┃ 🔸 *${prefix}cartao* - Ver cartão de crédito
┃ 🔸 *${prefix}pagarcartao <valor>* - Pagar cartão
┃ 🔸 *${prefix}extrato* - Ver extrato bancário
┃ 🔸 *${prefix}temporada* - Ver temporada
┃ 🔸 *${prefix}duelo @pessoa [valor]* - Desafiar para duelo
┃ 🔸 *${prefix}aceitar* - Aceitar duelo
┃ 🔸 *${prefix}recusar* - Recusar duelo
┃
┃ 🛡️ *ADMINISTRAÇÃO*
┃ 🔸 *${prefix}d* / *${prefix}apagar* - Apaga mensagem
┃ 🔸 *${prefix}acmd* - Painel administrativo
┃ 🔸 *${prefix}antispam on/off* - Anti-spam (salvo após reiniciar)
┃ 🔸 *${prefix}mute @pessoa* / *${prefix}unmute @pessoa* - Silenciar
┃ 🔸 *${prefix}unmuteall* - Desmutar todos
┃ 🔸 *${prefix}promover* / *${prefix}promote* - Promover admin
┃ 🔸 *${prefix}rebaixar* / *${prefix}demote* - Remover admin
┃ 🔸 *${prefix}ban* / *${prefix}kick* - Remover membro
┃ 🔸 *${prefix}add* - Adicionar membro
┃ 🔸 *${prefix}fechar* / *${prefix}abrir* - Abrir/fechar grupo
┃ 🔸 *${prefix}ngrp* / *${prefix}dgrp* - Alterar nome/descrição
┃ 🔸 *${prefix}admgrupo* - Painel de ações do grupo com botões (ADM)
┃ 🔸 *${prefix}icon GP* - Troca a foto respondendo a uma imagem (ADM)
┃ 🔸 *${prefix}avisoson* / *${prefix}avisosoff* - Logs do grupo
┃ 🔸 *${prefix}ativarverquemmodificou1/0* - Rastreamento de mudanças
┃ 🔸 *${prefix}verquemmodificou* - Ver alterações
┃ 🔸 *${prefix}ativarmsgale1/0* - Mensagens aleatórias
┃ 🔸 *${prefix}restart* - Reinicia o bot (dono ou admin do grupo)
┃
┃ 👑 *DONO DO BOT*
┃ 🔸 *${prefix}dono* - Menu do dono
┃ 🔸 *${prefix}testar* - Modo teste
┃ 🔸 *${prefix}setlog <texto>* - Alterar log
┃ 🔸 *${prefix}settat <texto>* - Alterar aviso de teste
┃ 🔸 *${prefix}aviso* / *${prefix}reaviso* - Gerenciar avisos
┃ 🔸 *${prefix}gp dinheiro* - Gerencia saldo, XP, nível
┃    e cadastro bancário de um grupo
┃ 🔸 *${prefix}resetgp* - Reset por categoria, perfil completo ou GP inteiro
┃ 🔸 *${prefix}cadastrarbanco @pessoa* - Cadastrar outra pessoa
┃    (uso exclusivo do dono)
┃ 🔸 *${prefix}ligar* / *${prefix}desligar* - Ativar/desativar bot
╰━━━━━━━━━━━━━━━━━━`.trim();

                            try {
                                const caminhoImagem = path.join(PASTA_MIDIA, 'menu.jpg');
                                const imageBuffer = await readFile(caminhoImagem);
                                await sock.sendMessage(remoteJid, { image: imageBuffer, caption: menuText }, { quoted: m });
                                await progressoMenu?.finalizar('Menu enviado!');
                            } catch (erro) {
                                const respostaEditada = await progressoMenu?.substituir({ text: menuText });
                                if (!respostaEditada) {
                                    await sock.sendMessage(remoteJid, { text: menuText }, { quoted: m });
                                    await progressoMenu?.finalizar('Menu enviado!');
                                }
                            }
                            break;
                        }
                            
                        case 'brincadeiras1':
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem ativar as brincadeiras.' }, { quoted: m });
                            }
                            if (!dadosGlobais.brincadeiras) dadosGlobais.brincadeiras = {};
                            dadosGlobais.brincadeiras[remoteJid] = true;
                            if (!dadosGlobais.mensagensAleatorias) dadosGlobais.mensagensAleatorias = {};
                            if (dadosGlobais.mensagensAleatorias[remoteJid] === undefined) {
                                dadosGlobais.mensagensAleatorias[remoteJid] = true;
                            }
                            await salvarDadosBot(dadosGlobais);
                            resetarInatividade(remoteJid);
                            await sock.sendMessage(remoteJid, { text: '✅ *Menu de brincadeiras ATIVADO!*\nO sistema de XP, Banco e aviso de inatividade já estão ativos! 🎉\nMande msgs para ganhar XP, e use .trabalhar para farmar R$!' }, { quoted: m });
                            break;

                        case 'brincadeiras0':
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem desativar as brincadeiras.' }, { quoted: m });
                            }
                            if (!dadosGlobais.brincadeiras) dadosGlobais.brincadeiras = {};
                            dadosGlobais.brincadeiras[remoteJid] = false;
                            await salvarDadosBot(dadosGlobais);
                            if (temporizadoresInatividade[remoteJid]) {
                                clearTimeout(temporizadoresInatividade[remoteJid]);
                                delete temporizadoresInatividade[remoteJid];
                            }
                            await sock.sendMessage(remoteJid, { text: '❌ *Menu de brincadeiras DESATIVADO!* 🔇\nXP e Banco paralisados.' }, { quoted: m });
                            break;

                        case 'ativarmsgale1':
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            }
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem ativar as mensagens aleatórias.' }, { quoted: m });
                            }

                            if (!dadosGlobais.mensagensAleatorias) dadosGlobais.mensagensAleatorias = {};
                            dadosGlobais.mensagensAleatorias[remoteJid] = true;
                            await salvarDadosBot(dadosGlobais);
                            resetarInatividade(remoteJid);

                            await sock.sendMessage(remoteJid, {
                                text: '✅ *Mensagens aleatórias ATIVADAS!* 🗣️\nSe ninguém mandar mensagem, o bot poderá enviar um lembrete depois de alguns minutos.'
                            }, { quoted: m });
                            break;

                        case 'ativarmsgale0':
                        case 'ativatmsgale0':
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            }
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem desativar as mensagens aleatórias.' }, { quoted: m });
                            }

                            if (!dadosGlobais.mensagensAleatorias) dadosGlobais.mensagensAleatorias = {};
                            dadosGlobais.mensagensAleatorias[remoteJid] = false;

                            if (temporizadoresInatividade[remoteJid]) {
                                clearTimeout(temporizadoresInatividade[remoteJid]);
                                delete temporizadoresInatividade[remoteJid];
                            }

                            await salvarDadosBot(dadosGlobais);
                            await sock.sendMessage(remoteJid, {
                                text: '🔇 *Mensagens aleatórias DESATIVADAS!* Não vou mandar mensagens de silêncio neste grupo.'
                            }, { quoted: m });
                            break;

                        case 'cadastrarbanco': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });

                            const contextoCadastro = corpoMsg?.extendedTextMessage?.contextInfo || m.message?.extendedTextMessage?.contextInfo || {};
                            const alvoCadastroMencionado = contextoCadastro.mentionedJid?.[0] || null;

                            // Dono pode cadastrar outra pessoa marcando-a.
                            if (alvoCadastroMencionado && souDono) {
                                const alvoCadastroCanonico = await resolverJidCanonicoGrupo(remoteJid, alvoCadastroMencionado, true);
                                if (alvoCadastroCanonico && alvoCadastroCanonico !== alvoCadastroMencionado) {
                                    await migrarDadosIdentidadeGrupo(remoteJid, alvoCadastroMencionado, alvoCadastroCanonico);
                                }
                                const chaveAlvoCadastro = await obterChaveCanonicaUsuarioGrupo(remoteJid, alvoCadastroCanonico);

                                garantirEconomia(dadosGlobais, chaveAlvoCadastro);

                                const statusAntes = statusCadastroBanco(dadosGlobais, remoteJid, alvoCadastroCanonico);
                                registrarCadastroBanco(dadosGlobais, remoteJid, alvoCadastroCanonico);
                                garantirProgressoJogador(dadosGlobais, chaveAlvoCadastro);
                                verificarConquistas(dadosGlobais, remoteJid, chaveAlvoCadastro);
                                await salvarDadosBot(dadosGlobais);

                                const saldoAlvoCadastro = Number(dadosGlobais.economia[chaveAlvoCadastro].dinheiro) || 0;
                                return await sock.sendMessage(remoteJid, {
                                    text: `${statusAntes === 'cadastrado' ? 'ℹ️' : '✅'} *CADASTRO NO BANCO ${statusAntes === 'cadastrado' ? 'JÁ ESTAVA ATIVO' : 'REALIZADO'}!* 🏦\n\n` +
                                          `👤 Cliente: @${normalizarJid(alvoCadastroCanonico)}\n` +
                                          `💰 Saldo: *R$ ${saldoAlvoCadastro.toFixed(2)}*\n\n` +
                                          `Status salvo nos dados: *cadastrado*.`,
                                    mentions: [alvoCadastroMencionado]
                                }, { quoted: m });
                            }

                            // Sem marcação, qualquer usuário pode cadastrar a própria conta.
                            const jidCadastroCanonico = await resolverJidCanonicoGrupo(remoteJid, senderCanonico, true);
                            if (jidCadastroCanonico && jidCadastroCanonico !== senderCanonico) {
                                await migrarDadosIdentidadeGrupo(remoteJid, senderCanonico, jidCadastroCanonico);
                                senderCanonico = jidCadastroCanonico;
                            }
                            const chaveCadastro = await obterChaveCanonicaUsuarioGrupo(remoteJid, senderCanonico);
                            const statusAtualCadastro = statusCadastroBanco(dadosGlobais, remoteJid, senderCanonico);
                            if (statusAtualCadastro === 'cadastrado') {
                                return await sock.sendMessage(remoteJid, { text: 'ℹ️ Você já possui um cadastro ativo no Banco.' }, { quoted: m });
                            }

                            if (!dadosGlobais.economia) dadosGlobais.economia = {};
                            garantirEconomia(dadosGlobais, chaveCadastro);
                            registrarCadastroBanco(dadosGlobais, remoteJid, senderCanonico);
                            garantirProgressoJogador(dadosGlobais, chaveCadastro);
                            verificarConquistas(dadosGlobais, remoteJid, chaveCadastro);
                            await salvarDadosBot(dadosGlobais);

                            const saldoCadastro = Number(dadosGlobais.economia[chaveCadastro].dinheiro) || 0;
                            return await sock.sendMessage(remoteJid, {
                                text: `✅ *CADASTRO NO BANCO REALIZADO!* 🏦\n\n` +
                                      `👤 Cliente: @${cleanSender}\n` +
                                      `💰 Saldo inicial: *R$ ${saldoCadastro.toFixed(2)}*\n` +
                                      `📌 Status salvo nos dados: *cadastrado*\n\n` +
                                      `Agora você pode usar os comandos da economia que exigem cadastro.`,
                                mentions: [senderCanonico]
                            }, { quoted: m });
                        }

                        case 'desativarcada': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });

                            if (!dadosGlobais.cadastrosBanco) dadosGlobais.cadastrosBanco = {};
                            const chaveCadastroRemover = chaveCadastroBanco(remoteJid, senderCanonico);
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) {
                                return await sock.sendMessage(remoteJid, { text: 'ℹ️ Você não possui um cadastro no Banco.' }, { quoted: m });
                            }

                            removerCadastroBanco(dadosGlobais, remoteJid, senderCanonico);
                            await salvarDadosBot(dadosGlobais);
                            return await sock.sendMessage(remoteJid, {
                                text: `🗑️ *CADASTRO REMOVIDO!*\n\n@${cleanSender}, seu cadastro no Banco foi desativado.\n📌 Status salvo nos dados: *removido*.\n💰 O saldo/XP continuam armazenados e serão recuperados caso você se cadastre novamente.`,
                                mentions: [senderCanonico]
                            }, { quoted: m });
                        }

                        case 'perfil':
                        case 'xp':
                        case 'banco':
                        case 'carteira':
                        case 'statusjogador': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });

                            // Se marcar alguém ou responder à mensagem de alguém,
                            // mostra o perfil dessa pessoa. Sem alvo, mostra o próprio perfil.
                            const contextoPerfil = corpoMsg?.extendedTextMessage?.contextInfo || m.message?.extendedTextMessage?.contextInfo || {};
                            const alvoMencionado = contextoPerfil.mentionedJid?.[0];
                            const alvoCitado = contextoPerfil.participant;
                            const alvoPerfil = alvoMencionado || alvoCitado || senderCanonico;
                            const alvoCanonico = await resolverJidCanonicoGrupo(remoteJid, alvoPerfil);
                            const chavePerfil = await obterChaveCanonicaUsuarioGrupo(remoteJid, alvoCanonico);
                            let xpUser = 0, nvUser = 1, dinUser = 0;

                            if (dadosGlobais.xpStatus && dadosGlobais.xpStatus[chavePerfil]) {
                                xpUser = Number(dadosGlobais.xpStatus[chavePerfil].xp) || 0;
                                nvUser = Number(dadosGlobais.xpStatus[chavePerfil].nivel) || 1;
                            }
                            if (dadosGlobais.economia && dadosGlobais.economia[chavePerfil]) {
                                dinUser = Number(dadosGlobais.economia[chavePerfil].dinheiro) || 0;
                            }

                            const myXpReq = nvUser < XP_MAX_LEVEL ? xpNecessarioNivel(nvUser) : 'MÁXIMO';
                            const cadastrado = bancoCadastrado(dadosGlobais, remoteJid, alvoCanonico);
                            const statusCadastro = statusCadastroBanco(dadosGlobais, remoteJid, alvoCanonico);
                            const contaPerfil = garantirEconomia(dadosGlobais, chavePerfil);
                            const progressoPerfil = garantirProgressoJogador(dadosGlobais, chavePerfil);
                            const diarioPerfil = dadosGlobais.diarios?.[chavePerfil] || { streak: 0 };
                            const novasConquistasPerfil = verificarConquistas(dadosGlobais, remoteJid, chavePerfil);
                            if (novasConquistasPerfil.length) await salvarDadosBot(dadosGlobais);
                            const conquistasPerfil = Object.keys(dadosGlobais.conquistas?.[chavePerfil] || {}).length;
                            const tempPerfil = garantirTemporadaGrupo(dadosGlobais, remoteJid).temp;
                            const pontosPerfil = Number(tempPerfil.pontos?.[chavePerfil]) || 0;
                            const saldoTexto = cadastrado ? `R$ ${(Number(contaPerfil.dinheiro) || 0).toFixed(2)}` : '🚫 *CADASTRO NECESSÁRIO*';
                            const avisoCadastro = cadastrado ? '' : `\n\n🏦 Status do cadastro: *${statusCadastro}*. Para ativar, use *${prefix}cadastrarbanco*.`;
                            const perfilProprio = normalizarJid(alvoCanonico) === normalizarJid(senderCanonico);
                            const limiteCartaoPerfil = garantirLimiteCartao(contaPerfil);
                            const dividaCartaoPerfil = Number(contaPerfil.cartaoCredito?.divida) || 0;
                            const disponivelCartaoPerfil = Math.max(0, limiteCartaoPerfil - dividaCartaoPerfil);
                            const blocoCartaoPerfil = perfilProprio
                                ? `\n💳 *Cartão:* R$ ${limiteCartaoPerfil.toFixed(2)}\n` +
                                  `🧾 *Dívida:* R$ ${dividaCartaoPerfil.toFixed(2)}\n` +
                                  `🟢 *Crédito disponível:* R$ ${disponivelCartaoPerfil.toFixed(2)}`
                                : '';
                            const textoPerfilCompleto = `╭━━━ *PERFIL* ━━━╮\n` +
                                      `👤 *@${normalizarJid(alvoCanonico)}*\n\n` +
                                      `📋 *Cadastro:* ${statusCadastro}\n` +
                                      `🌟 *Nível:* ${nvUser}\n` +
                                      `✨ *XP:* ${xpUser}/${myXpReq}\n` +
                                      `💰 *Saldo:* ${saldoTexto}\n` +
                                      `🏦 *Poupança:* R$ ${(Number(contaPerfil.poupanca) || 0).toFixed(2)}\n` +
                                      `🛡️ *Proteção:* ${contaPerfil.protecaoRoubo > 0 ? '1 disponível' : '0'}\n` +
                                      `🏷️ *Título:* ${contaPerfil.titulo || 'Nenhum'}\n` +
                                      `🔥 *Daily:* ${Number(diarioPerfil.streak) || 0} dia(s)\n` +
                                      `🏆 *Conquistas:* ${conquistasPerfil}/${Object.keys(DEFINICOES_CONQUISTAS).length}\n` +
                                      `⚔️ *Duelos:* ${progressoPerfil.duelos} | Vitórias: ${progressoPerfil.vitoriasDuelos}\n` +
                                      `🏆 *Temporada ${tempPerfil.id}:* ${pontosPerfil} pontos` +
                                      `${blocoCartaoPerfil}\n` +
                                      `╰━━━━━━━━━━━━━━╯${avisoCadastro}`;
                            let fotoPerfilUrl = null;
                            try {
                                fotoPerfilUrl = await sock.profilePictureUrl(alvoCanonico, 'image');
                            } catch (_) {
                                // Perfil pode estar sem foto ou com privacidade restrita; fallback para texto.
                            }
                            if (fotoPerfilUrl) {
                                await sock.sendMessage(remoteJid, {
                                    image: { url: fotoPerfilUrl },
                                    caption: textoPerfilCompleto,
                                    mentions: [alvoCanonico]
                                }, { quoted: m });
                            } else {
                                await sock.sendMessage(remoteJid, {
                                    text: textoPerfilCompleto,
                                    mentions: [alvoCanonico]
                                }, { quoted: m });
                            }
                            break;
                        }

                        // Brincadeira: tapa em uma única pessoa, usando GIF aleatório de ./gif.
                        case 'tapa': {
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, {
                                    text: '❌ O comando .tapa só funciona em grupos.'
                                }, { quoted: m });
                            }
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.`
                                }, { quoted: m });
                            }

                            // Exige uma única menção; não há modo "todos" neste comando.
                            const contextoTapa = corpoMsg?.extendedTextMessage?.contextInfo ||
                                m.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo ||
                                m.message?.extendedTextMessage?.contextInfo || {};
                            const alvoMencionadoTapa = contextoTapa.mentionedJid?.[0];
                            if (!alvoMencionadoTapa) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `🫲💥 Marque apenas uma pessoa para dar uma tapa de brincadeira: *${prefix}tapa @pessoa*.`
                                }, { quoted: m });
                            }

                            const alvoTapa = await resolverJidCanonicoGrupo(remoteJid, alvoMencionadoTapa);
                            const autorTapa = await resolverJidCanonicoGrupo(remoteJid, senderCanonico);
                            if (!alvoTapa || !autorTapa) {
                                return await sock.sendMessage(remoteJid, {
                                    text: '😕 Não consegui identificar quem vai dar ou receber a tapa. Marque a pessoa novamente.'
                                }, { quoted: m });
                            }
                            const jidBotTapa = getBotJid();
                            if (jidBotTapa && [alvoMencionadoTapa, alvoTapa].some(jid => normalizarJid(jid) === normalizarJid(jidBotTapa))) {
                                return await sock.sendMessage(remoteJid, {
                                    text: 'perae, que fazer isso com o bot é?🤣🤣'
                                }, { quoted: m });
                            }
                            if (normalizarJid(alvoTapa) === normalizarJid(autorTapa)) {
                                return await sock.sendMessage(remoteJid, {
                                    text: '😂 Você tentou dar uma tapa em si mesmo? Marca outra pessoa!'
                                }, { quoted: m });
                            }

                            let arquivoTapa = null;
                            let saidaTapa = null;
                            try {
                                await mkdir(PASTA_GIF, { recursive: true });
                                await mkdir(PASTA_TEMP, { recursive: true });
                                const entradasTapa = await readdir(PASTA_GIF, { withFileTypes: true });
                                const candidatosTapa = [];
                                for (const entradaTapa of entradasTapa) {
                                    if (!entradaTapa.isFile() || !/\.(?:gif|mp4|webm|mov)$/i.test(entradaTapa.name)) continue;
                                    const baseNomeTapa = entradaTapa.name.replace(/\.[^.]+$/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
                                    // O comando .tapa também só pode escolher animações da própria categoria.
                                    if (!/^tapa(?:$|[_ -]|\d)/.test(baseNomeTapa)) continue;
                                    const caminhoTapa = path.join(PASTA_GIF, entradaTapa.name);
                                    try {
                                        const statTapa = await (await import('fs/promises')).stat(caminhoTapa);
                                        if (statTapa.isFile() && statTapa.size > 0 && statTapa.size <= 25 * 1024 * 1024) {
                                            candidatosTapa.push(caminhoTapa);
                                        }
                                    } catch (_) {}
                                }
                                if (!candidatosTapa.length) {
                                    return await sock.sendMessage(remoteJid, {
                                        text: `📁 Não encontrei GIF para o comando tapa. Coloque GIFs animados na pasta *${path.relative(__dirname, PASTA_GIF)}/* (na mesma pasta de index.js) e tente novamente. Aceito .gif, .mp4, .webm ou .mov até 25 MB.`
                                    }, { quoted: m });
                                }

                                arquivoTapa = candidatosTapa[Math.floor(Math.random() * candidatosTapa.length)];
                                const nomeSaidaTapa = `tapa-${Date.now()}-${Math.random().toString(16).slice(2, 10)}.mp4`;
                                saidaTapa = path.join(PASTA_TEMP, nomeSaidaTapa);

                                const converterTapa = async (reduzido = false) => {
                                    const largura = reduzido ? '320' : '360';
                                    const fps = reduzido ? '10' : '12';
                                    const crf = reduzido ? '34' : '31';
                                    await executarProcesso('ffmpeg', [
                                        '-hide_banner', '-loglevel', 'error', '-y',
                                        '-i', arquivoTapa,
                                        '-t', '8',
                                        '-vf', `fps=${fps},scale=${largura}:-2:flags=lanczos`,
                                        '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
                                        '-crf', crf, '-pix_fmt', 'yuv420p',
                                        '-movflags', '+faststart', '-f', 'mp4', saidaTapa
                                    ], { timeoutMs: 45000, maxBuffer: 256 * 1024 });
                                };

                                // WhatsApp costuma receber GIF animado como vídeo MP4 em loop.
                                await converterTapa(false);
                                let statSaidaTapa = await (await import('fs/promises')).stat(saidaTapa);
                                if (!statSaidaTapa.isFile() || statSaidaTapa.size <= 0) {
                                    throw new Error('O FFmpeg não gerou um vídeo válido.');
                                }
                                if (statSaidaTapa.size > 8 * 1024 * 1024) {
                                    await converterTapa(true);
                                    statSaidaTapa = await (await import('fs/promises')).stat(saidaTapa);
                                }
                                if (statSaidaTapa.size > 8 * 1024 * 1024) {
                                    throw new Error('O GIF convertido ainda ficou maior que 8 MB. Use uma animação menor.');
                                }

                                const bufferTapa = await readFile(saidaTapa);
                                const fraseTapa = `🫲 @${normalizarJid(autorTapa)} deu uma tapa na raba bem gostosa em @${normalizarJid(alvoTapa)}! 😂`;
                                return await sock.sendMessage(remoteJid, {
                                    video: bufferTapa,
                                    mimetype: 'video/mp4',
                                    gifPlayback: true,
                                    caption: fraseTapa,
                                    mentions: [...new Set([autorTapa, alvoMencionadoTapa, alvoTapa])]
                                }, { quoted: m });
                            } catch (erroTapa) {
                                console.error('[TAPA] Falha ao selecionar, converter ou enviar GIF:', erroTapa?.message || erroTapa);
                                const detalheTapa = /ENOENT|spawn ffmpeg|not found/i.test(String(erroTapa?.message || ''))
                                    ? 'O FFmpeg não está disponível. No Termux, instale com: pkg install ffmpeg -y.'
                                    : 'Não consegui processar essa animação. Tente outro arquivo GIF menor.';
                                return await sock.sendMessage(remoteJid, {
                                    text: `❌ ${detalheTapa}`
                                }, { quoted: m });
                            } finally {
                                if (saidaTapa) await unlink(saidaTapa).catch(() => {});
                            }
                        }

                        // Brincadeira: traçar uma pessoa ou causar o caos marcando o grupo inteiro 😂
                        case 'tracar':
                        case 'traçar':
                        case 'traca':
                        case 'traça':
                        case 'molestar':
                        case 'fuder':
                        case 'gozarem': {
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Essa bagunça só pode acontecer em grupos KKKKK.' }, { quoted: m });
                            }
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) {
                                return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            }

                            const argumentoTracar = String(textArgs || '').trim().normalize('NFKC').toLowerCase();
                            const frasesTracarGeral = [
                                'EITA, ELE TRAÇOU O BUMBUM DE GERALKKKKKK😭📊',
                                '🚨 ALERTA DE GOZOS: o cidadão ativou o modo “ninguém escapa da transa” e marcou o grupo inteiro KKKKK.',
                                'COMENDO GERAL 😂💀',
                                'Ninguem tem o foreba mais em pazkkkkk 📈',
                                '📢 Comunicado oficial: foi detectado um surto de transador. Favor manter a transa a uma distância bem perto KKKKKK.'
                            ];
                            const frasesTracarUm = [
                                'EITA, que ele comeu bem gostoso a bunda del(e/a)KKKKK 💀',
                                '👀 O grupo viu, comeram o cara aq agorinha.',
                                '🚨 Que traça gostosa e gulosa 😂',
                                'pegou a bunda dele e comeu gostosoKKKKK 🏹',
                                'bumbum guloso gostoso 😭'
                            ];

                            if (['todos', 'todo mundo', 'geral', 'tds', 'grupo', 'todes'].includes(argumentoTracar)) {
                                try {
                                    const metaTracarGeral = await obterMetadadosGrupoComTimeout(remoteJid);
                                    const participantesTracar = Array.isArray(metaTracarGeral?.participants) ? metaTracarGeral.participants : [];
                                    const mencoesTracar = [];
                                    const vistosTracar = new Set();

                                    for (const participanteTracar of participantesTracar) {
                                        const jidOriginalTracar = participanteTracar?.phoneNumber || participanteTracar?.jid || participanteTracar?.id || participanteTracar?.lid;
                                        if (!jidOriginalTracar) continue;
                                        const jidTracar = await resolverJidCanonicoGrupo(remoteJid, jidOriginalTracar);
                                        if (!jidTracar) continue;
                                        const chaveTracar = normalizarJid(jidTracar);
                                        if (!chaveTracar || vistosTracar.has(chaveTracar)) continue;
                                        vistosTracar.add(chaveTracar);
                                        mencoesTracar.push(jidTracar);
                                    }

                                    if (!mencoesTracar.length) {
                                        return await sock.sendMessage(remoteJid, { text: '😵 O sistema perdeu a lista de contatinhos. Tenta de novo daqui a pouco KKKKK.' }, { quoted: m });
                                    }
                                    const autorTracarGeral = await resolverJidCanonicoGrupo(remoteJid, senderCanonico);
                                    const fraseTracar = frasesTracarGeral[Math.floor(Math.random() * frasesTracarGeral.length)];
                                    const bufferGifTracarGeral = await criarVideoGifBrincadeira('tracar');
                                    return await enviarGifComTodosNaLegenda({
                                        sock,
                                        remoteJid,
                                        buffer: bufferGifTracarGeral,
                                        legendaBase: `*SAIU TRAÇANDO GERAL* 😂\n\n@${normalizarJid(autorTracarGeral)} resolveu traçar o grupo inteiro!\n${fraseTracar}`,
                                        autorJid: autorTracarGeral,
                                        participantesJid: mencoesTracar,
                                        quoted: m
                                    });
                                } catch (erroTracarGeral) {
                                    console.error('Erro no comando traçar todos:', erroTracarGeral);
                                    return await sock.sendMessage(remoteJid, { text: '❌ A transa caiu por instabilidade no sistema. Não consegui marcar o grupo todo agora.' }, { quoted: m });
                                }
                            }

                            const contextoTracar = corpoMsg?.extendedTextMessage?.contextInfo ||
                                m.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo ||
                                m.message?.extendedTextMessage?.contextInfo || {};
                            const alvoMencionadoTracar = contextoTracar.mentionedJid?.[0];
                            if (!alvoMencionadoTracar) {
                                return await sock.sendMessage(remoteJid, { text: `😂 Marque alguém para entrar na transa: *${prefix}traçar @pessoa*\nOu aperte o botão vermelho do caos com *${prefix}traçar todos* KKKKK.` }, { quoted: m });
                            }

                            const alvoTracar = await resolverJidCanonicoGrupo(remoteJid, alvoMencionadoTracar);
                            const autorTracar = await resolverJidCanonicoGrupo(remoteJid, senderCanonico);
                            const jidBotTracar = getBotJid();
                            if (jidBotTracar && [alvoMencionadoTracar, alvoTracar].some(jid => normalizarJid(jid) === normalizarJid(jidBotTracar))) {
                                return await sock.sendMessage(remoteJid, { text: 'perae, que fazer isso com o bot é?🤣🤣' }, { quoted: m });
                            }
                            if (!alvoTracar || !autorTracar) {
                                return await sock.sendMessage(remoteJid, { text: '😕 Não consegui identificar quem foi marcado. Tenta marcar novamente.' }, { quoted: m });
                            }
                            if (normalizarJid(alvoTracar) === normalizarJid(autorTracar)) {
                                return await sock.sendMessage(remoteJid, { text: 'KKKKKK tentou traçar a si mesmo? A autoestima tá em dia, hein 😂💀' }, { quoted: m });
                            }
                            const bufferGifTracar = await criarVideoGifBrincadeira('tracar');
                            const fraseTracarUm = frasesTracarUm[Math.floor(Math.random() * frasesTracarUm.length)];
                            return await sock.sendMessage(remoteJid, {
                                video: bufferGifTracar,
                                mimetype: 'video/mp4',
                                gifPlayback: true,
                                caption: `👀🚨 @${normalizarJid(autorTracar)} traçou @${normalizarJid(alvoTracar)}!\n\n${fraseTracarUm}`,
                                mentions: [...new Set([autorTracar, alvoMencionadoTracar, alvoTracar])]
                            }, { quoted: m });
                        }

                        // Comando de brincadeira: aliases aceitos para evitar diferenças de digitação.
                        case 'beijar':
                        case 'beija':
                        case 'beijo': {
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            }
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) {
                                return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            }
                            // Modo especial: beijo em TODO MUNDO do grupo (poliamor caótico 😂).
                            // Aceita .beijo todos, .beijar todos, .beija geral e .beijo todo mundo.
                            const alvoTextoBeijar = String(textArgs || '').trim().normalize('NFKC').toLowerCase();
                            if (['todos', 'todo mundo', 'geral', 'tds', 'grupo', 'todes'].includes(alvoTextoBeijar)) {
                                try {
                                    const metadataBeijoGeral = await obterMetadadosGrupoComTimeout(remoteJid);
                                    const participantesBeijoGeral = Array.isArray(metadataBeijoGeral?.participants)
                                        ? metadataBeijoGeral.participants : [];
                                    const mencoesBeijoGeral = [];
                                    const vistosBeijoGeral = new Set();

                                    for (const participanteBeijoGeral of participantesBeijoGeral) {
                                        const jidOriginalBeijoGeral = participanteBeijoGeral?.phoneNumber ||
                                            participanteBeijoGeral?.jid || participanteBeijoGeral?.id || participanteBeijoGeral?.lid;
                                        if (!jidOriginalBeijoGeral) continue;
                                        const jidBeijoGeral = await resolverJidCanonicoGrupo(remoteJid, jidOriginalBeijoGeral);
                                        if (!jidBeijoGeral) continue;
                                        const chaveBeijoGeral = normalizarJid(jidBeijoGeral);
                                        if (!chaveBeijoGeral || vistosBeijoGeral.has(chaveBeijoGeral)) continue;
                                        vistosBeijoGeral.add(chaveBeijoGeral);
                                        mencoesBeijoGeral.push(jidBeijoGeral);
                                    }

                                    if (!mencoesBeijoGeral.length) {
                                        return await sock.sendMessage(remoteJid, {
                                            text: '😵 O cartório do amor tentou consultar a lista de convidados, mas o sistema caiu. Tenta de novo daqui a pouco!'
                                        }, { quoted: m });
                                    }

                                    const caosPoliamor = [
                                        '📜 O cartório confirmou: agora é relacionamento aberto com o grupo INTEIRO KKKKK.',
                                        '💍 Casamento coletivo ativado; o advogado já está digitando KKKKK.',
                                        '🚨 A monogamia pediu demissão! O coração virou condomínio 😂💋',
                                        '🛐 O cartório fechou mais cedo: é poliamor em escala industrial KKKKK.',
                                        '💌 Beijo ilimitado e fofoca compartilhada 😂'
                                    ];
                                    const fraseCaosBeijo = caosPoliamor[Math.floor(Math.random() * caosPoliamor.length)];
                                    const autorBeijoGeral = await resolverJidCanonicoGrupo(remoteJid, senderCanonico);
                                    const bufferGifBeijoGeral = await criarVideoGifBrincadeira('beijar');
                                    return await enviarGifComTodosNaLegenda({
                                        sock,
                                        remoteJid,
                                        buffer: bufferGifBeijoGeral,
                                        legendaBase: `💋🚨 *ESCÂNDALO NO CARTÓRIO DO AMOR* 🚨💋\n\n@${normalizarJid(autorBeijoGeral)} resolveu beijar TODO MUNDO!\n${fraseCaosBeijo}`,
                                        autorJid: autorBeijoGeral,
                                        participantesJid: mencoesBeijoGeral,
                                        quoted: m
                                    });
                                } catch (erroBeijoGeral) {
                                    console.error('Erro no comando beijo geral:', erroBeijoGeral);
                                    return await sock.sendMessage(remoteJid, {
                                        text: '❌ O cartório do amor perdeu a lista do grupo! Não consegui marcar geral agora. Tenta novamente.'
                                    }, { quoted: m });
                                }
                            }

                            const contextoBeijar = corpoMsg?.extendedTextMessage?.contextInfo ||
                                m.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo ||
                                m.message?.extendedTextMessage?.contextInfo || {};
                            const alvoMencionadoBeijar = contextoBeijar.mentionedJid?.[0];
                            if (!alvoMencionadoBeijar) {
                                return await sock.sendMessage(remoteJid, { text: `💋 Marque alguém do grupo: *${prefix}beijar @pessoa* ou use *${prefix}beijo todos* para instaurar a poligamia KKKKK.` }, { quoted: m });
                            }
                            const alvoBeijado = await resolverJidCanonicoGrupo(remoteJid, alvoMencionadoBeijar);
                            const autorBeijo = await resolverJidCanonicoGrupo(remoteJid, senderCanonico);
                            const jidBotBeijar = getBotJid();
                            if (jidBotBeijar && [alvoMencionadoBeijar, alvoBeijado].some(jid => normalizarJid(jid) === normalizarJid(jidBotBeijar))) {
                                return await sock.sendMessage(remoteJid, { text: 'perae, que fazer isso com o bot é?🤣🤣' }, { quoted: m });
                            }
                            if (!alvoBeijado || !autorBeijo) {
                                return await sock.sendMessage(remoteJid, { text: '😕 Não consegui identificar quem foi marcado. Tenta marcar novamente.' }, { quoted: m });
                            }
                            if (normalizarJid(alvoBeijado) === normalizarJid(autorBeijo)) {
                                return await sock.sendMessage(remoteJid, { text: '😂 Beijar a si mesmo? KKKKK marca outra pessoa!' }, { quoted: m });
                            }
                            const frasesBeijo = [
                                'e foi um beijinho tímido na bochecha KKKKK 😂',
                                'e o beijo foi tão rápido que quase ninguém viu! 😳',
                                'e se brincar foi até beijo de língua KKKKKKK 💀😂',
                                'foi beijo de novela, só faltou a música dramática! 🎬💋',
                                'mas errou o lado e quase beijou a testa KKKKK 🤣',
                                'o grupo inteiro viu e agora quer fofoca! 👀😂',
                                'e depois ainda fingiu que não aconteceu nada KKKKK 😭'
                            ];
                            const bufferGifBeijo = await criarVideoGifBrincadeira('beijar');
                            const fraseBeijo = frasesBeijo[Math.floor(Math.random() * frasesBeijo.length)];
                            return await sock.sendMessage(remoteJid, {
                                video: bufferGifBeijo,
                                mimetype: 'video/mp4',
                                gifPlayback: true,
                                caption: `💋 @${normalizarJid(autorBeijo)} beijou @${normalizarJid(alvoBeijado)} ${fraseBeijo}`,
                                mentions: [...new Set([autorBeijo, alvoMencionadoBeijar, alvoBeijado])]
                            }, { quoted: m });
                        }
        
        case 'cheirar':
                        case 'cheira':
                        case 'cheirarcu': {
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            }
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) {
                                return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            }
                            // Modo especial: beijo em TODO MUNDO do grupo (poliamor caótico 😂).
                            // Aceita .beijo todos, .beijar todos, .beija geral e .beijo todo mundo.
                            const alvoTextoBeijar = String(textArgs || '').trim().normalize('NFKC').toLowerCase();
                            if (['todos', 'todo mundo', 'geral'].includes(alvoTextoBeijar)) {
                                try {
                                    const metadataCheirarGeral = await obterMetadadosGrupoComTimeout(remoteJid);
                                    const participantesCheirarGeral = Array.isArray(metadataCheirarGeral?.participants)
                                        ? metadataCheirarGeral.participants : [];
                                    const mencoesCheirarGeral = [];
                                    const vistosCheirarGeral = new Set();

                                    for (const participanteCheirarGeral of participantesCheirarGeral) {
                                        const jidOriginalCheirarGeral = participanteCheirarGeral?.phoneNumber ||
                                            participanteCheirarGeral?.jid || participanteCheirarGeral?.id || participanteCheirarGeral?.lid;
                                        if (!jidOriginalCheirarGeral) continue;
                                        const jidCheirarGeral = await resolverJidCanonicoGrupo(remoteJid, jidOriginalCheirarGeral);
                                        if (!jidCheirarGeral) continue;
                                        const chaveCheirarGeral = normalizarJid(jidCheirarGeral);
                                        if (!chaveCheirarGeral || vistosCheirarGeral.has(chaveCheirarGeral)) continue;
                                        vistosCheirarGeral.add(chaveCheirarGeral);
                                        mencoesCheirarGeral.push(jidCheirarGeral);
                                    }

                                    if (!mencoesCheirarGeral.length) {
                                        return await sock.sendMessage(remoteJid, {
                                            text: '😵O sistema de cheirar cu caiu, tente mais tarde '
                                        }, { quoted: m });
                                    }

                                    const chamadasCheirarGeral = mencoesCheirarGeral
                                        .map(jid => `@${normalizarJid(jid)}`).join(' ');
                                    const caosCheirarCu = [
                                        'Cheiro de cu maravilhoso é desses cara inteiro',
                                        'O cara abriu o brioco de geral pra cheirarkkkkkkkkk',
                                        '🚨O Cara enlouqueceu e enfiou o nariz no cu de geral kkkkk😂',
                                        'Esse cara encontrou muita mina de merda cheirosa.',
                                        'Acabou de cheirar o cu de todo mundo kkkkkk😂'
                                    ];
                                    const fraseCaosCheirar = caosCheirarCu[Math.floor(Math.random() * caosCheirarCu.length)];
                                    const autorCheirarGeral = await resolverJidCanonicoGrupo(remoteJid, senderCanonico);
                                    const textoCheirarGeral = `🚨 *EITA PORRA CHEIRANDO O FURICO DE GERAL* 🚨

@${normalizarJid(autorCheirarGeral)} resolveu cheirar o cu de TODO MUNDO do grupo!

${fraseCaosCheirar}

*cheirando esses cu:*
${chamadasCheirarGeral}

😂 _Cu cheiroso hmmmmmm kkkkkkkk._`;
                                    const imagemCheirarGeralEnviada = await enviarImagemComTodosNaLegenda({
                                        sock,
                                        remoteJid,
                                        nomeArquivo: 'cheirar.jpeg',
                                        legendaBase: `🚨 *EITA PORRA CHEIRANDO O FURICO DE GERAL* 🚨\n\n@${normalizarJid(autorCheirarGeral)} resolveu cheirar o cu de TODO MUNDO do grupo!\n\n${fraseCaosCheirar}\n\n*cheirando esses cu:*`,
                                        legendaSufixo: '😂 _Cu cheiroso hmmmmmm kkkkkkkk._',
                                        autorJid: autorCheirarGeral,
                                        participantesJid: mencoesCheirarGeral,
                                        quoted: m
                                    });
                                    if (imagemCheirarGeralEnviada) return;
                                    return await sock.sendMessage(remoteJid, {
                                        text: textoCheirarGeral,
                                        mentions: [...new Set([autorCheirarGeral, ...mencoesCheirarGeral])]
                                    }, { quoted: m });
                                } catch (erroCheirarGeral) {
                                    console.error('Erro no comando cheiro cu geral:', erroCheirarGeral);
                                    return await sock.sendMessage(remoteJid, {
                                        text: '❌ O cheiro cu perdeu a lista do grupo! Não consegui marcar geral agora. Tenta novamente.'
                                    }, { quoted: m });
                                }
                            }

                            const contextoCheirar = corpoMsg?.extendedTextMessage?.contextInfo ||
                                m.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo ||
                                m.message?.extendedTextMessage?.contextInfo || {};
                            const alvoMencionadoCheirar = contextoCheirar.mentionedJid?.[0];
                            if (!alvoMencionadoCheirar) {
                                return await sock.sendMessage(remoteJid, { text: ` Marque alguém do grupo: *${prefix}cheirarr @pessoa* ou use *${prefix}cheirar todos* para instaurar a maior cu cheirosos KKKKK.` }, { quoted: m });
                            }
                            const alvoCheirado = await resolverJidCanonicoGrupo(remoteJid, alvoMencionadoCheirar);
                            const autorCheiro = await resolverJidCanonicoGrupo(remoteJid, senderCanonico);
                            if (normalizarJid(alvoCheirado) === normalizarJid(autorCheiro)) {
                                return await sock.sendMessage(remoteJid, { text: '😂 Cheirar a si mesmo? KKKKK marca outra pessoa!' }, { quoted: m });
                            }
                            const frasesCheiro = [
                                'Cheirou as nádegas do cara po KKKKK 😂',
                                'que cheiro gostoso, quero cheirar mais😳',
                                'e se brincar foi ate língua no fundo do poço 💀😂',
                                'Cheirou igual kid bengala kkkkkkk! 🎬💋',
                                'O cara lambeu ao invez de cheirar 🤣',
                                'o grupo viu o cara cheirando? Cheirou até sair merreca pelo nariz! 👀😂',
                                'Cheirou e fingiu que tava fedendo 😭'
                            ];
                            const fraseCheirar = frasesCheiro[Math.floor(Math.random() * frasesCheiro.length)];
                            const textoCheirar = `😱 @${normalizarJid(autorCheiro)} Cheirou o cu de @${normalizarJid(alvoCheirado)} ${fraseCheirar}`;
                            const mencoesCheirar = [...new Set([autorCheiro, alvoMencionadoCheirar, alvoCheirado])];
                            const imagemCheirarEnviada = await enviarImagemMidiaSeExistir(remoteJid, 'cheirar.jpeg', {
                                quoted: m,
                                caption: textoCheirar,
                                mentions: mencoesCheirar
                            });
                            if (imagemCheirarEnviada) return;
                            return await sock.sendMessage(remoteJid, { text: textoCheirar, mentions: mencoesCheirar }, { quoted: m });
                        }

                        case 'rankrico':
                        case 'maisrico':
                        case 'rico': {
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, {
                                    text: '❌ Este comando só funciona em grupos.'
                                }, { quoted: m });
                            }
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });

                            try {
                                const metaRankRico = await obterMetadadosGrupoComTimeout(remoteJid);
                                const participantesRankRico = Array.isArray(metaRankRico?.participants)
                                    ? metaRankRico.participants
                                    : [];
                                const elegiveisRankRico = [];
                                const idsParticipantesVistos = new Set();
                                const prefixoChaveGrupoRico = `${remoteJid}_`;

                                // Usa todos os aliases fornecidos pelo Baileys (número/JID/LID),
                                // sem consultar groupMetadata novamente nem migrar dados durante o ranking.
                                for (const participante of participantesRankRico) {
                                    try {
                                        const aliasesBrutos = [
                                            participante?.phoneNumber,
                                            participante?.jid,
                                            participante?.id,
                                            participante?.lid
                                        ].filter(v => typeof v === 'string' && v.trim());
                                        if (!aliasesBrutos.length) continue;

                                        const aliasesJidRico = [...new Set(aliasesBrutos.map(valor => {
                                            const id = valor.trim();
                                            if (id.includes('@')) return id;
                                            const somenteDigitos = id.replace(/\D/g, '');
                                            return somenteDigitos ? `${somenteDigitos}@s.whatsapp.net` : '';
                                        }).filter(Boolean))];
                                        const idsNormalizadosRico = [...new Set(aliasesJidRico.map(normalizarJid).filter(Boolean))];
                                        if (!idsNormalizadosRico.length || idsNormalizadosRico.some(id => idsParticipantesVistos.has(id))) continue;
                                        for (const id of idsNormalizadosRico) idsParticipantesVistos.add(id);

                                        const chavesPossiveisRico = [...new Set(idsNormalizadosRico.map(id => `${prefixoChaveGrupoRico}${id}`))];
                                        let possuiContaRico = false;
                                        let cadastroAtivoRico = false;
                                        let dinheiroRico = 0;
                                        let chaveSaldoRico = chavesPossiveisRico[0];
                                        let encontrouSaldoRico = false;

                                        for (const chavePossivel of chavesPossiveisRico) {
                                            const registro = dadosGlobais.cadastrosBanco?.[chavePossivel];
                                            if (registro === true || registro?.status === 'cadastrado') cadastroAtivoRico = true;

                                            const contaPossivel = dadosGlobais.economia?.[chavePossivel];
                                            if (!contaPossivel || typeof contaPossivel !== 'object') continue;
                                            possuiContaRico = true;
                                            const saldoPossivel = Number(contaPossivel.dinheiro);
                                            const saldoValido = Number.isFinite(saldoPossivel) ? saldoPossivel : 0;
                                            if (!encontrouSaldoRico || saldoValido > dinheiroRico) {
                                                dinheiroRico = saldoValido;
                                                chaveSaldoRico = chavePossivel;
                                                encontrouSaldoRico = true;
                                            }
                                        }

                                        // Mantém compatibilidade com perfis antigos que têm conta, mas não
                                        // possuem mais um registro explícito de cadastro.
                                        if (!cadastroAtivoRico && !possuiContaRico) continue;

                                        const jidMencaoRico = aliasesJidRico.find(id => id.endsWith('@s.whatsapp.net'))
                                            || aliasesJidRico.find(id => !id.endsWith('@lid'))
                                            || aliasesJidRico[0];
                                        const chaveXpRico = chavesPossiveisRico.find(chave => dadosGlobais.xpStatus?.[chave]) || chaveSaldoRico;
                                        const statsRico = dadosGlobais.xpStatus?.[chaveXpRico] || {};

                                        elegiveisRankRico.push({
                                            jid: jidMencaoRico,
                                            dinheiro: dinheiroRico,
                                            nivel: Number(statsRico.nivel) || 1,
                                            xp: Number(statsRico.xp) || 0
                                        });
                                    } catch (erroParticipanteRico) {
                                        console.warn('[rankrico] Participante ignorado por falha na leitura dos dados:', erroParticipanteRico?.message || erroParticipanteRico);
                                    }
                                }

                                if (elegiveisRankRico.length === 0) {
                                    return await sock.sendMessage(remoteJid, {
                                        text: `❌ Não encontrei contas bancárias válidas neste grupo. Use *${prefix}cadastrarbanco* e tente novamente.`
                                    }, { quoted: m });
                                }

                                // Mantém o objetivo original do comando: o maior saldo do grupo
                                // sempre participa; os outros quatro (ou menos) são sorteados sem repetir.
                                const ordenadosPorSaldoRico = [...elegiveisRankRico].sort((a, b) => b.dinheiro - a.dinheiro);
                                const maisRicoGrupo = ordenadosPorSaldoRico[0];
                                const restantesRankRico = ordenadosPorSaldoRico.slice(1);
                                for (let i = restantesRankRico.length - 1; i > 0; i--) {
                                    const j = Math.floor(Math.random() * (i + 1));
                                    [restantesRankRico[i], restantesRankRico[j]] = [restantesRankRico[j], restantesRankRico[i]];
                                }
                                const escolhidosRankRico = [maisRicoGrupo, ...restantesRankRico.slice(0, 4)]
                                    .sort((a, b) => b.dinheiro - a.dinheiro);
                                const mencoesRankRico = escolhidosRankRico.map(j => j.jid);
                                const medalhasRankRico = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
                                const linhasRankRico = escolhidosRankRico.map((jogador, indice) =>
                                    `${medalhasRankRico[indice]} ${indice === 0 ? '*MAIS RICO ENTRE OS SORTEADOS* — ' : ''}@${normalizarJid(jogador.jid)} — 💰 *R$ ${jogador.dinheiro.toFixed(2)}*`
                                );
                                const saldoMaisAltoRico = escolhidosRankRico[0].dinheiro;
                                const empatadosRankRico = escolhidosRankRico.filter(j => j.dinheiro === saldoMaisAltoRico);
                                const textoVencedorRankRico = empatadosRankRico.length > 1
                                    ? `👑 *EMPATE! Os mais ricos entre os sorteados:* ${empatadosRankRico.map(j => `@${normalizarJid(j.jid)}`).join(', ')} — *R$ ${saldoMaisAltoRico.toFixed(2)}*`
                                    : `👑 *O MAIS RICO ENTRE OS SORTEADOS:* @${normalizarJid(escolhidosRankRico[0].jid)} — *R$ ${saldoMaisAltoRico.toFixed(2)}*`;

                                return await sock.sendMessage(remoteJid, {
                                    text: `💰 *QUEM É O MAIS RICO DO GRUPO?*\n\n${textoVencedorRankRico}\n\n🎲 *Ranking de até 5 participantes sorteados:*\n\n${linhasRankRico.join('\n')}\n\n📌 Foram comparados os saldos encontrados no Banco.`,
                                    mentions: [...new Set(mencoesRankRico)]
                                }, { quoted: m });
                            } catch (erroRankRico) {
                                console.error('Erro no comando rankrico:', erroRankRico?.stack || erroRankRico);
                                return await sock.sendMessage(remoteJid, {
                                    text: '❌ Não consegui consultar os participantes/saldos agora. Tente novamente em alguns segundos e confira a conexão do bot.'
                                }, { quoted: m });
                            }
                        }
                        break;

                        case 'rank':
                        case 'ranking':
                        case 'bateriadogrupo':
                        case 'maisricos': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });

                            try {
                                const metaRank = await obterMetadadosGrupoComTimeout(remoteJid);
                                const participantesRank = Array.isArray(metaRank.participants) ? metaRank.participants : [];
                                const jogadoresRank = [];

                                for (const participante of participantesRank) {
                                    const jidOriginal = participante.phoneNumber || participante.jid || participante.id;
                                    if (!jidOriginal) continue;

                                    const jidRank = await resolverJidCanonicoGrupo(remoteJid, jidOriginal);
                                    const chaveRank = await obterChaveCanonicaUsuarioGrupo(remoteJid, jidRank);
                                    const chavesPossiveisRank = [...new Set([
                                        chaveRank,
                                        `${remoteJid}_${normalizarJid(jidRank)}`,
                                        `${remoteJid}_${normalizarJid(jidOriginal)}`
                                    ])];
                                    let chaveSaldoRank = chaveRank;
                                    let dinheiroRank = 0;
                                    for (const chavePossivel of chavesPossiveisRank) {
                                        const saldoPossivel = Number(dadosGlobais.economia?.[chavePossivel]?.dinheiro) || 0;
                                        if (saldoPossivel > dinheiroRank || !dadosGlobais.economia?.[chaveSaldoRank]) {
                                            dinheiroRank = saldoPossivel;
                                            chaveSaldoRank = chavePossivel;
                                        }
                                    }
                                    const possuiContaRank = chavesPossiveisRank.some(chave => dadosGlobais.economia?.[chave]);
                                    if (!bancoCadastrado(dadosGlobais, remoteJid, jidRank) && !possuiContaRank) continue;

                                    const statsRank = obterStatsXP(chaveSaldoRank);
                                    jogadoresRank.push({
                                        jid: jidRank,
                                        dinheiro: dinheiroRank,
                                        nivel: Number(statsRank.nivel) || 1,
                                        xp: Number(statsRank.xp) || 0
                                    });
                                }

                                if (!jogadoresRank.length) {
                                    return await sock.sendMessage(remoteJid, {
                                        text: `🏆 *RANK DO GRUPO*\n\n😕 Ainda não há jogadores cadastrados no Banco.\nUse *${prefix}cadastrarbanco* para entrar no ranking.`
                                    }, { quoted: m });
                                }

                                const argumentoRank = String(texto || '').trim().toLowerCase();
                                const porNivel = ['nivel', 'nível', 'level', 'xp'].includes(argumentoRank);

                                jogadoresRank.sort((a, b) => {
                                    if (porNivel) {
                                        if (b.nivel !== a.nivel) return b.nivel - a.nivel;
                                        if (b.xp !== a.xp) return b.xp - a.xp;
                                        return b.dinheiro - a.dinheiro;
                                    }
                                    if (b.dinheiro !== a.dinheiro) return b.dinheiro - a.dinheiro;
                                    if (b.nivel !== a.nivel) return b.nivel - a.nivel;
                                    return b.xp - a.xp;
                                });

                                const tituloRank = porNivel ? 'MAIORES NÍVEIS' : 'MAIS RICOS';
                                const medalhas = ['🥇', '🥈', '🥉'];
                                const linhasRank = jogadoresRank.map((jogador, indice) => {
                                    const posicao = medalhas[indice] || `${indice + 1}º`;
                                    const xpReqRank = jogador.nivel < XP_MAX_LEVEL ? xpNecessarioNivel(jogador.nivel) : 'MÁXIMO';
                                    if (porNivel) {
                                        return `${posicao} @${normalizarJid(jogador.jid)} — 🌟 Nível ${jogador.nivel} | ✨ XP ${jogador.xp}/${xpReqRank} | 💰 R$ ${jogador.dinheiro.toFixed(2)}`;
                                    }
                                    return `${posicao} @${normalizarJid(jogador.jid)} — 💰 R$ ${jogador.dinheiro.toFixed(2)} | 🌟 Nível ${jogador.nivel} | ✨ XP ${jogador.xp}/${xpReqRank}`;
                                }).join('\n');

                                return await sock.sendMessage(remoteJid, {
                                    text: `🏆 *RANK DO GRUPO — ${tituloRank}*\n\n${linhasRank}\n\n📌 Use *${prefix}rank dinheiro* para os mais ricos ou *${prefix}rank nivel* para os maiores níveis.`,
                                    mentions: jogadoresRank.map(j => j.jid)
                                }, { quoted: m });
                            } catch (erroRank) {
                                console.error('Erro no ranking do grupo:', erroRank);
                                return await sock.sendMessage(remoteJid, { text: '❌ Não foi possível montar o ranking deste grupo.' }, { quoted: m });
                            }
                        }
                        break;

                        
                        case 'ativarverquemmodificou1':
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem ativar o rastreamento.' }, { quoted: m });
                            }
                            if (!dadosGlobais.verQuemModificou) dadosGlobais.verQuemModificou = {};
                            dadosGlobais.verQuemModificou[remoteJid] = true;
                            await salvarDadosBot(dadosGlobais);
                            await sock.sendMessage(remoteJid, {
                                text: '✅ *Ver quem modificou o grupo ATIVADO!* As próximas alterações serão registradas.'
                            }, { quoted: m });
                            break;

                        case 'ativarverquemmodificou0':
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem desativar o rastreamento.' }, { quoted: m });
                            }

                            if (!dadosGlobais.verQuemModificou) dadosGlobais.verQuemModificou = {};
                            dadosGlobais.verQuemModificou[remoteJid] = false;
                            await salvarDadosBot(dadosGlobais);
                            await sock.sendMessage(remoteJid, {
                                text: '❌ *Ver quem modificou o grupo DESATIVADO!*'
                            }, { quoted: m });
                            break;

                        case 'verquemmodificou':
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem consultar esse registro.' }, { quoted: m });
                            }

                            if (!dadosGlobais.verQuemModificou?.[remoteJid]) {
                                return await sock.sendMessage(remoteJid, {
                                    text: '❌ O rastreamento não está ativado neste grupo.\nUse * .ativarverquemmodificou1* (sem o espaço) para ativar.'
                                }, { quoted: m });
                            }

                            const logsAtual = dadosGlobais.logsModificacoesGrupo?.[remoteJid] || [];
                            if (logsAtual.length === 0) {
                                return await sock.sendMessage(remoteJid, { text: 'ℹ️ Nenhuma alteração foi registrada ainda.' }, { quoted: m });
                            }

                            const ultimosLogs = logsAtual.slice(0, 15);
                            const mencoesLogs = [];
                            const linhasLogs = ultimosLogs.map((log, index) => {
                                const dataLog = new Date(log.timestamp).toLocaleString('pt-BR');
                                const ator = log.autor || 'desconhecido';
                                if (ator.includes('@') && !mencoesLogs.includes(ator)) mencoesLogs.push(ator);
                                for (const p of (log.participantes || [])) {
                                    if (p && !mencoesLogs.includes(p)) mencoesLogs.push(p);
                                }

                                const acaoTexto = descricaoModificacaoGrupo(
                                    ator,
                                    log.acao,
                                    log.participantes || [],
                                    log.detalhes || ''
                                ).replace(/\n/g, ' ');

                                return `*${index + 1}.* ${dataLog}\n${acaoTexto}`;
                            }).join('\n\n');

                            await sock.sendMessage(remoteJid, {
                                text: `🔎 *ÚLTIMAS MODIFICAÇÕES DO GRUPO*\n\n${linhasLogs}`,
                                mentions: mencoesLogs
                            }, { quoted: m });
                            break;
                        case 'apostar':
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) {
                                return await sock.sendMessage(remoteJid, { text: `🏦 *Cadastro necessário!*\n\nUse *${prefix}cadastrarbanco* para poder apostar.` }, { quoted: m });
                            }

                            const contaAposta = garantirEconomia(dadosGlobais, userGroupKey);
                            const saldoAposta = Number(contaAposta.dinheiro) || 0;
                            if (saldoAposta <= 0) {
                                return await sock.sendMessage(remoteJid, { text: '💸 Você está sem dinheiro para apostar! Use `.trabalhar` para conseguir mais.' }, { quoted: m });
                            }

                            const valorApostaTexto = (args[0] || '').trim().toLowerCase();
                            let valorAposta = valorApostaTexto === 'tudo'
                                ? saldoAposta
                                : Number.parseFloat(valorApostaTexto.replace(',', '.'));

                            if (!Number.isFinite(valorAposta) || valorAposta <= 0) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `❌ Valor inválido.\n\nUse *${prefix}apostar 50* ou *${prefix}apostar tudo*.\n💰 Seu saldo: *R$ ${saldoAposta.toFixed(2)}*`
                                }, { quoted: m });
                            }
                            valorAposta = Math.round(valorAposta * 100) / 100;

                            if (valorAposta > saldoAposta) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `💸 Você não pode apostar mais do que possui!\n\n🎰 Aposta: *R$ ${valorAposta.toFixed(2)}*\n💰 Saldo: *R$ ${saldoAposta.toFixed(2)}*`
                                }, { quoted: m });
                            }

                            const sorteioAposta = Math.random();
                            let resultadoAposta;
                            let novoSaldoAposta;
                            let multiplicadorAposta;

                            if (sorteioAposta < APOSTAR_CHANCE_PERDER) {
                                resultadoAposta = 'perdeu';
                                multiplicadorAposta = 0;
                                novoSaldoAposta = saldoAposta - valorAposta;
                            } else if (sorteioAposta < APOSTAR_CHANCE_PERDER + APOSTAR_CHANCE_DOBRAR) {
                                resultadoAposta = 'dobrou';
                                multiplicadorAposta = 2;
                                novoSaldoAposta = saldoAposta + valorAposta;
                            } else if (sorteioAposta < APOSTAR_CHANCE_PERDER + APOSTAR_CHANCE_DOBRAR + APOSTAR_CHANCE_TRIPLICAR) {
                                resultadoAposta = 'triplicou';
                                multiplicadorAposta = 3;
                                novoSaldoAposta = saldoAposta + (valorAposta * 2);
                            }

                            contaAposta.dinheiro = Math.max(0, Math.round(novoSaldoAposta * 100) / 100);
                            await salvarDadosBot(dadosGlobais);

                            let textoResultadoAposta;
                            if (resultadoAposta === 'perdeu') {
                                textoResultadoAposta =
                                    `💀 *VOCÊ PERDEU!*\n\n` +
                                    `🎰 Apostou: *R$ ${valorAposta.toFixed(2)}*\n` +
                                    `📉 Resultado: *Perdeu tudo!*\n` +
                                    `💰 Novo saldo: *R$ ${contaAposta.dinheiro.toFixed(2)}*`;
                            } else {
                                const valorRecebidoAposta = valorAposta * multiplicadorAposta;
                                const lucroAposta = valorRecebidoAposta - valorAposta;
                                textoResultadoAposta =
                                    `${multiplicadorAposta === 3 ? '🔥' : '🎉'} *${multiplicadorAposta === 3 ? 'TRIPLICOU!' : 'DOBROU!'}*\n\n` +
                                    `🎰 Apostou: *R$ ${valorAposta.toFixed(2)}*\n` +
                                    `💵 Recebeu: *R$ ${valorRecebidoAposta.toFixed(2)}*\n` +
                                    `📈 Lucro: *R$ ${lucroAposta.toFixed(2)}*\n` +
                                    `💰 Novo saldo: *R$ ${contaAposta.dinheiro.toFixed(2)}*`;
                            }

                            await sock.sendMessage(remoteJid, {
                                text: `🎲 *APOSTA DE @${cleanSender}*\n\n${textoResultadoAposta}\n\n🎯 Chances: *35% perder* | *45% dobro* | *20% triplo*`,
                                mentions: [sender]
                            }, { quoted: m });
                            break;

                        case 'comprarxp':
                        case 'buyxp':
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) {
                                return await sock.sendMessage(remoteJid, { text: `🏦 *Cadastro necessário!*\n\nVocê precisa se cadastrar para usar o dinheiro do Banco.\nUse *${prefix}cadastrarbanco* para começar.` }, { quoted: m });
                            }

                            const quantidadeXP = Number.parseInt(args[0], 10);
                            const precoXP = precoComprarXP(quantidadeXP);

                            if (!Number.isInteger(quantidadeXP) || quantidadeXP < 10 || quantidadeXP > 100 || quantidadeXP % 10 !== 0 || precoXP === null) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `❌ Quantidade inválida.\nUse de *10 em 10 XP*, entre *10 e 100*.\nEx.: *${prefix}comprarxp 10*, *${prefix}comprarxp 20* ou *${prefix}comprarxp 100*.`
                                }, { quoted: m });
                            }

                            if (!dadosGlobais.economia) dadosGlobais.economia = {};
                            if (!dadosGlobais.economia[userGroupKey]) {
                                dadosGlobais.economia[userGroupKey] = { dinheiro: 100, lastWork: 0, lastRob: 0 };
                            }

                            if (dadosGlobais.economia[userGroupKey].dinheiro < precoXP) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `💸 Saldo insuficiente!\n\nPreço: *R$ ${precoXP.toFixed(2)}*\nSeu saldo: *R$ ${dadosGlobais.economia[userGroupKey].dinheiro.toFixed(2)}*`
                                }, { quoted: m });
                            }

                            const statsCompraXP = obterStatsXP(userGroupKey);
                            if (statsCompraXP.nivel >= XP_MAX_LEVEL) {
                                return await sock.sendMessage(remoteJid, { text: '🏆 Você já está no *Nível 30*, o nível máximo. Não é possível comprar mais XP.' }, { quoted: m });
                            }

                            const nivelAntesCompra = statsCompraXP.nivel;
                            const xpAntesCompra = statsCompraXP.xp;

                            dadosGlobais.economia[userGroupKey].dinheiro -= precoXP;
                            registrarTransacao(dadosGlobais, userGroupKey, 'xp', -precoXP, `Compra de ${quantidadeXP} XP`);
                            const levelsCompra = aplicarXP(statsCompraXP, quantidadeXP);
                            garantirProgressoJogador(dadosGlobais, userGroupKey).xpGanho += quantidadeXP;
                            adicionarPontosTemporadaSemValidacao(dadosGlobais, remoteJid, userGroupKey, 2);
                            verificarConquistas(dadosGlobais, remoteJid, userGroupKey);
                            const dinheiroNivelCompra = levelsCompra > 0
                                ? adicionarRecompensaNivel(userGroupKey, nivelAntesCompra, statsCompraXP.nivel)
                                : 0;

                            await salvarDadosBot(dadosGlobais);

                            const xpDepoisCompra = statsCompraXP.nivel >= XP_MAX_LEVEL
                                ? '0/MÁXIMO'
                                : `${statsCompraXP.xp}/${xpNecessarioNivel(statsCompraXP.nivel)}`;

                            await sock.sendMessage(remoteJid, {
                                text: `🛒 *COMPRA DE XP REALIZADA!*\n\n` +
                                      `✨ Comprado: *+${quantidadeXP} XP*\n` +
                                      `💰 Pago: *R$ ${precoXP.toFixed(2)}*\n` +
                                      `📊 Antes: *Nível ${nivelAntesCompra} — ${xpAntesCompra}/${xpNecessarioNivel(nivelAntesCompra)} XP*\n` +
                                      `📈 Depois: *Nível ${statsCompraXP.nivel} — ${xpDepoisCompra} XP*` +
                                      (levelsCompra > 0 ? `\n🎊 Você subiu *${levelsCompra} nível(is)*!` : '') +
                                      (dinheiroNivelCompra > 0 ? `\n💰 Recompensa de nível: *+R$ ${dinheiroNivelCompra.toFixed(2)}*\n💵 Saldo atual: *R$ ${(Number(dadosGlobais.economia[userGroupKey]?.dinheiro) || 0).toFixed(2)}*` : '')
                            }, { quoted: m });
                            break;

                        case 'trabalhar':
                        case 'work':
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) {
                                return await sock.sendMessage(remoteJid, { text: `🏦 *Cadastro necessário!*\n\nUse *${prefix}cadastrarbanco* para poder trabalhar e receber dinheiro.` }, { quoted: m });
                            }

                            if (!dadosGlobais.economia) dadosGlobais.economia = {};
                            garantirEconomia(dadosGlobais, userGroupKey);
                            
                            const agrTrab = Date.now();
                            const cdTrab = 25000; // 25 segundos de cooldown para trabalhar
                            
                            if (agrTrab - (dadosGlobais.economia[userGroupKey].lastWork || 0) < cdTrab) {
                                const resto = Math.ceil((cdTrab - (agrTrab - dadosGlobais.economia[userGroupKey].lastWork)) / 1000);
                                return await sock.sendMessage(remoteJid, { text: `Você está cansado! Descanse por *${resto}s* antes de trabalhar de novo.` }, { quoted: m });
                            }

                            dadosGlobais.economia[userGroupKey].lastWork = agrTrab;

                            let ganhos = 0;
                            let sorte = Math.random();
                            let msgTrab = '';

                            if (sorte > 0.95) { // 5% de chance extrema
                                ganhos = Math.floor(Math.random() * 950) + 50; // De 50 a 1000
                                msgTrab = `🎉 *INACREDITÁVEL!* Você prestou um serviço milionário e ganhou *R$ ${ganhos}*!`;
                            } else {
                                ganhos = Math.floor(Math.random() * 31) + 20; // De 20 a 50
                                msgTrab = `💼 Você trabalhou duro hoje e ganhou *R$ ${ganhos}*.`;
                            }

                            const contaTrab = garantirEconomia(dadosGlobais, userGroupKey);
                            contaTrab.dinheiro += ganhos;
                            registrarTransacao(dadosGlobais, userGroupKey, 'trabalho', ganhos, 'Recompensa por trabalhar');
                            garantirProgressoJogador(dadosGlobais, userGroupKey).trabalhos += 1;
                            registrarMissao(dadosGlobais, userGroupKey, 'trabalhos', 1);
                            aplicarXPPendenteDasMissoes(userGroupKey);
                            adicionarPontosTemporadaSemValidacao(dadosGlobais, remoteJid, userGroupKey, 5);
                            verificarConquistas(dadosGlobais, remoteJid, userGroupKey);
                            await salvarDadosBot(dadosGlobais);
                            await sock.sendMessage(remoteJid, { text: `${msgTrab}\n💰 Saldo atual: *R$ ${contaTrab.dinheiro.toFixed(2)}*` }, { quoted: m });
                            break;

                        case 'roubar':
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) {
                                return await sock.sendMessage(remoteJid, { text: `🏦 *Cadastro necessário!*\n\nUse *${prefix}cadastrarbanco* para poder usar o roubo.` }, { quoted: m });
                            }

                            const alvoMencionadoRoubo = await obterMencionado(corpoMsg, m);
                            if (!alvoMencionadoRoubo) return await sock.sendMessage(remoteJid, { text: `❌ Marque alguém para tentar roubar! Ex: *${prefix}roubar @pessoa*` }, { quoted: m });

                            // O WhatsApp pode entregar @lid ou JID de telefone para a mesma pessoa.
                            // Resolver e usar a chave canônica evita procurar um cadastro com ID diferente.
                            const alvo = await resolverJidCanonicoGrupo(remoteJid, alvoMencionadoRoubo, true);
                            if (!alvo) return await sock.sendMessage(remoteJid, { text: '❌ Não consegui identificar a pessoa marcada. Tente marcar novamente.' }, { quoted: m });
                            if (alvo !== alvoMencionadoRoubo) {
                                await migrarDadosIdentidadeGrupo(remoteJid, alvoMencionadoRoubo, alvo);
                            }
                            if (normalizarJid(alvo) === cleanSender) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Você não pode se roubar!' }, { quoted: m });
                            }

                            const alvoKey = await obterChaveCanonicaUsuarioGrupo(remoteJid, alvo);
                            if (!bancoCadastrado(dadosGlobais, remoteJid, alvo)) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Essa pessoa não possui um cadastro ativo no Banco deste grupo, então não tem uma conta bancária para ser roubada.' }, { quoted: m });
                            }

                            if (!dadosGlobais.economia) dadosGlobais.economia = {};
                            garantirEconomia(dadosGlobais, userGroupKey);
                            if (!dadosGlobais.economia[alvoKey]) dadosGlobais.economia[alvoKey] = { dinheiro: 100, lastWork: 0, lastRob: 0 };

                            const contaAlvoRoubo = garantirEconomia(dadosGlobais, alvoKey);
                            const contaLadraoRoubo = garantirEconomia(dadosGlobais, userGroupKey);

                            if (contaAlvoRoubo.dinheiro < 10) {
                                return await sock.sendMessage(remoteJid, { text: `❌ Essa pessoa não tem dinheiro suficiente para ser roubada (pobre).` }, { quoted: m });
                            }

                            const agrRob = Date.now();
                            const cdRob = 40000; // 40 segundos de cooldown para roubo
                            
                            if (agrRob - (dadosGlobais.economia[userGroupKey].lastRob || 0) < cdRob) {
                                const restoR = Math.ceil((cdRob - (agrRob - dadosGlobais.economia[userGroupKey].lastRob)) / 1000);
                                return await sock.sendMessage(remoteJid, { text: `A polícia está de olho em você! Espere *${restoR}s* para roubar.` }, { quoted: m });
                            }

                            dadosGlobais.economia[userGroupKey].lastRob = agrRob;

                            // 🛡️ A proteção é consumível: bloqueia 1 tentativa válida e depois some.
                            if (Number(contaAlvoRoubo.protecaoRoubo) > 0) {
                                contaAlvoRoubo.protecaoRoubo = 0;
                                garantirProgressoJogador(dadosGlobais, alvoKey).protecoesUsadas += 1;
                                registrarTransacao(dadosGlobais, alvoKey, 'protecao', 0, `Proteção contra roubo consumida por tentativa de @${cleanSender}`);
                                await salvarDadosBot(dadosGlobais);
                                return await sock.sendMessage(remoteJid, {
                                    text: `🛡️ *ROUBO BLOQUEADO!*\n\n@${normalizarJid(alvo)} tinha uma *Proteção contra roubo*.\nA proteção foi *consumida* e não poderá ser usada novamente.\n\n🛒 Para obter outra, compre na *${prefix}loja*.`,
                                    mentions: [alvo]
                                }, { quoted: m });
                            }
                            
                            let chanceDeSucesso = Math.random();
                            
                            if (chanceDeSucesso > 0.6) { // 40% de chance de dar certo
                                // Pega entre 10% e 40% do dinheiro da vítima
                                let porcentagem = (Math.random() * 0.3) + 0.1;
                                let valorRoubado = Math.floor(dadosGlobais.economia[alvoKey].dinheiro * porcentagem);
                                
                                contaAlvoRoubo.dinheiro -= valorRoubado;
                                contaLadraoRoubo.dinheiro += valorRoubado;
                                registrarTransacao(dadosGlobais, alvoKey, 'roubo', -valorRoubado, `Roubo sofrido por @${cleanSender}`);
                                registrarTransacao(dadosGlobais, userGroupKey, 'roubo', valorRoubado, `Roubo realizado contra @${normalizarJid(alvo)}`);
                                
                                await sock.sendMessage(remoteJid, { 
                                    text: `🥷 *SUCESSO!* Você conseguiu roubar *R$ ${valorRoubado}* do @${normalizarJid(alvo)} de fininho...`,
                                    mentions: [alvo]
                                }, { quoted: m });

                            } else {
                                // Deu errado: 50% de chance de a polícia pegar.
                                // Como o roubo tem 60% de chance de falhar, isso dá 30% de chance total de ser preso.
                                let foiPreso = Math.random() > 0.5;
                                if (foiPreso) {
                                    const dinheiroPerdido = contaLadraoRoubo.dinheiro;
                                    contaLadraoRoubo.dinheiro = 0;
                                    registrarTransacao(dadosGlobais, userGroupKey, 'multa', -dinheiroPerdido, 'Punição por tentativa de roubo')
                                    
                                    await sock.sendMessage(remoteJid, { 
                                        text: `🚔 *A POLÍCIA TE PEGOU!* Você foi pego tentando roubar o @${normalizarJid(alvo)}!\n\n💸 A polícia levou *todo o seu dinheiro* (*R$ ${dinheiroPerdido.toFixed(2)}*) como punição.\n😂 Boa sorte na próxima!`,
                                        mentions: [alvo]
                                    }, { quoted: m });
                                } else {
                                    await sock.sendMessage(remoteJid, { 
                                        text: `🏃‍♂️ *QUASE!* O @${normalizarJid(alvo)} percebeu e você teve que fugir sem levar nada!`,
                                        mentions: [alvo]
                                    }, { quoted: m });
                                }
                            }
                            await salvarDadosBot(dadosGlobais);
                            break;

                        case 'daily':
                        case 'diario': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) {
                                return await sock.sendMessage(remoteJid, { text: `🏦 *Cadastro necessário!*\n\nUse *${prefix}cadastrarbanco* para receber sua recompensa diária.` }, { quoted: m });
                            }

                            if (!dadosGlobais.diarios) dadosGlobais.diarios = {};
                            const hojeDaily = dataLocalBot();
                            const ontemDaily = ontemLocalBot();
                            const diarioAtual = dadosGlobais.diarios[userGroupKey] || { ultimaData: null, streak: 0 };

                            if (diarioAtual.ultimaData === hojeDaily) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `🎁 *DAILY*\n\nVocê já pegou sua recompensa hoje!\n🔥 Sequência atual: *${diarioAtual.streak || 1} dia(s)*\n⏳ Volte amanhã.`,
                                }, { quoted: m });
                            }

                            diarioAtual.streak = diarioAtual.ultimaData === ontemDaily ? (Number(diarioAtual.streak) || 0) + 1 : 1;
                            diarioAtual.ultimaData = hojeDaily;
                            diarioAtual.ultimoPremio = Date.now();
                            dadosGlobais.diarios[userGroupKey] = diarioAtual;

                            const recompensaDaily = Math.min(
                                DAILY_MAX_STREAK_RECOMPENSA,
                                RECOMPENSA_DAILY_BASE + ((diarioAtual.streak - 1) * 75) + Math.floor(Math.random() * 101)
                            );
                            const contaDaily = garantirEconomia(dadosGlobais, userGroupKey);
                            contaDaily.dinheiro += recompensaDaily;
                            registrarTransacao(dadosGlobais, userGroupKey, 'daily', recompensaDaily, `Recompensa diária (${diarioAtual.streak}º dia)`);
                            const jurosDaily = Math.min(500, Math.floor((Math.max(0, contaDaily.poupanca) * 0.01) * 100) / 100);
                            if (jurosDaily > 0) {
                                contaDaily.poupanca += jurosDaily;
                                registrarTransacao(dadosGlobais, userGroupKey, 'juros', jurosDaily, 'Juros de 1% da poupança');
                            }
                            garantirProgressoJogador(dadosGlobais, userGroupKey);
                            const missaoDailyConcluida = registrarMissao(dadosGlobais, userGroupKey, 'daily', 1);
                            aplicarXPPendenteDasMissoes(userGroupKey);
                            const novasConquistasDaily = verificarConquistas(dadosGlobais, remoteJid, userGroupKey);
                            garantirTemporadaGrupo(dadosGlobais, remoteJid);
                            adicionarPontosTemporadaSemValidacao(dadosGlobais, remoteJid, userGroupKey, 10);
                            await salvarDadosBot(dadosGlobais);

                            return await sock.sendMessage(remoteJid, {
                                text: `🎁 *RECOMPENSA DIÁRIA RECEBIDA!*\n\n` +
                                      `💰 Você ganhou *R$ ${recompensaDaily.toFixed(2)}*\n` +
                                      `🔥 Sequência: *${diarioAtual.streak} dia(s)*\n` +
                                      `💵 Saldo: *R$ ${contaDaily.dinheiro.toFixed(2)}*` +
                                      (jurosDaily > 0 ? `\n🏦 Juros da poupança: *+R$ ${jurosDaily.toFixed(2)}*` : '') +
                                      (missaoDailyConcluida ? '\n🎯 *Missão diária concluída!*' : '') +
                                      (novasConquistasDaily.length ? `\n🏆 Novas conquistas: *${novasConquistasDaily.length}*` : ''),
                            }, { quoted: m });
                        }

                        case 'missoes':
                        case 'missao': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) {
                                return await sock.sendMessage(remoteJid, { text: `🏦 *Cadastro necessário!*\n\nUse *${prefix}cadastrarbanco* para acessar suas missões.` }, { quoted: m });
                            }

                            registrarMissao(dadosGlobais, userGroupKey, 'none', 0);
                            const estadoMissoes = dadosGlobais.missoesJogadores?.[userGroupKey] || { progresso: {}, concluidas: {} };
                            const linhasMissoes = MISOES_DIARIAS.map((missao) => {
                                const progresso = Math.min(missao.alvo, Number(estadoMissoes.progresso?.[missao.tipo]) || 0);
                                const concluida = !!estadoMissoes.concluidas?.[missao.id];
                                return `${concluida ? '✅' : '▫️'} ${missao.titulo}\n   └ ${progresso}/${missao.alvo} — 💰 R$ ${missao.recompensaDinheiro} + ✨ ${missao.recompensaXP} XP`;
                            }).join('\n\n');

                            return await sock.sendMessage(remoteJid, {
                                text: `🎯 *MISSÕES DIÁRIAS*\n\n${linhasMissoes}\n\n📅 Data: *${dataLocalBot()}*`,
                            }, { quoted: m });
                        }

                        case 'loja':
                        case 'shop': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) {
                                return await sock.sendMessage(remoteJid, { text: `🏦 *Cadastro necessário!*\n\nUse *${prefix}cadastrarbanco* para acessar a Loja.` }, { quoted: m });
                            }
                            const contaLoja = garantirEconomia(dadosGlobais, userGroupKey);
                            const protecaoStatus = contaLoja.protecaoRoubo > 0 ? '✅ Você já possui 1' : '❌ Nenhuma';
                            const menuLoja = `🛒 *LOJA DO GRUPO*\n\n` +
                                `1️⃣ *Proteção contra roubo* — R$ ${LOJA_ITENS.protecao.preco}\n   ${LOJA_ITENS.protecao.descricao}\n   ${protecaoStatus}\n\n` +
                                `2️⃣ *Kit de XP* — R$ ${LOJA_ITENS.kitxp.preco}\n   +30 XP imediatamente.\n\n` +
                                `3️⃣ *Kit de XP Plus* — R$ ${LOJA_ITENS.kitxp60.preco}\n   +60 XP imediatamente. Use *comprar kitxp60*.\n\n` +
                                `4️⃣ *Kit de XP Supremo* — R$ ${LOJA_ITENS.kitxp100.preco}\n   +100 XP imediatamente. Use *comprar kitxp100*.\n\n` +
                                `5️⃣ *Título VIP* — R$ ${LOJA_ITENS.titulo.preco}\n   Exibe *VIP* no seu perfil.\n\n` +
                                `💰 Seu saldo: *R$ ${contaLoja.dinheiro.toFixed(2)}*\n\n` +
                                `Use *${prefix}comprar <item>*\nEx.: *${prefix}comprar protecao*\n🛡️ A proteção contra roubo só pode ser paga com o saldo.`;
                            return await sock.sendMessage(remoteJid, { text: menuLoja }, { quoted: m });
                        }

                        case 'comprar':
                        case 'buy': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) {
                                return await sock.sendMessage(remoteJid, { text: `🏦 *Cadastro necessário!*\n\nUse *${prefix}cadastrarbanco* para comprar na Loja.` }, { quoted: m });
                            }

                            let itemLoja = String(args[0] || '').trim().toLowerCase();
                            const aliasesLoja = { '1': 'protecao', '2': 'kitxp', '3': 'kitxp60', '4': 'kitxp100', '5': 'titulo', 'proteção': 'protecao', 'shield': 'protecao', 'xp': 'kitxp', 'vip': 'titulo' };
                            itemLoja = aliasesLoja[itemLoja] || itemLoja;
                            const item = LOJA_ITENS[itemLoja];
                            if (!item) return await sock.sendMessage(remoteJid, { text: `❌ Item inválido. Use *${prefix}loja* para ver os produtos.` }, { quoted: m });

                            const contaCompra = garantirEconomia(dadosGlobais, userGroupKey);
                            if (itemLoja === 'protecao' && Number(contaCompra.protecaoRoubo) > 0) {
                                return await sock.sendMessage(remoteJid, { text: '🛡️ Você já possui uma proteção guardada. Ela será consumida na próxima tentativa de roubo.' }, { quoted: m });
                            }

                            const formaPagamento = String(args[1] || '').toLowerCase();
                            const usarCredito = ['credito', 'crédito', 'cartao', 'cartão', 'credit'].includes(formaPagamento);
                            const saldoAntesCompra = contaCompra.dinheiro;
                            let compraNoCredito = false;
                            const opcaoParcelamento = String(args[2] || '').toLowerCase();
                            const parcelasEscolhidas = ({ 'avista': 1, 'àvista': 1, '1x': 1, '2x': 2, '3x': 3, '1': 1, '2': 2, '3': 3 })[opcaoParcelamento];

                            if (usarCredito && !parcelasEscolhidas) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `💳 *COMO DESEJA PAGAR NO CRÉDITO?*\n\n🧾 Compra: *${item.nome}*\n💰 Valor: *R$ ${item.preco.toFixed(2)}*\n\nResponda escolhendo uma opção e repetindo o comando:\n\n1️⃣ À vista: *${prefix}comprar ${itemLoja} credito 1x*\n2️⃣ Em 2 parcelas: *${prefix}comprar ${itemLoja} credito 2x*\n3️⃣ Em 3 parcelas: *${prefix}comprar ${itemLoja} credito 3x*\n\n⚠️ As parcelas vencem a cada 5 minutos. Confirme apenas uma opção.`
                                }, { quoted: m });
                            }

                            if (usarCredito) {
                                atualizarJurosCartao(dadosGlobais);
                                const limiteCreditoCompra = garantirLimiteCartao(contaCompra);
                                const dividaCreditoCompra = Number(contaCompra.cartaoCredito.divida) || 0;
                                const disponivelCreditoCompra = Math.max(0, limiteCreditoCompra - dividaCreditoCompra);
                                if (item.preco > disponivelCreditoCompra) {
                                    return await sock.sendMessage(remoteJid, { text: `💳 Limite insuficiente.\n\nPreço: *R$ ${item.preco.toFixed(2)}*\nLimite disponível: *R$ ${disponivelCreditoCompra.toFixed(2)}*` }, { quoted: m });
                                }
                                if (dividaCreditoCompra > 0) {
                                    return await sock.sendMessage(remoteJid, { text: '💳 Você já possui uma dívida ativa no cartão. Quite ou parcele a dívida antes de fazer outra compra no crédito.' }, { quoted: m });
                                }
                                const agoraCredito = Date.now();
                                contaCompra.cartaoCredito.divida = Number(item.preco.toFixed(2));
                                contaCompra.cartaoCredito.principal = Number(item.preco.toFixed(2));
                                contaCompra.cartaoCredito.criadoEm = agoraCredito;
                                contaCompra.cartaoCredito.jurosInicio = agoraCredito + PRAZO_CARTAO_MS;
                                contaCompra.cartaoCredito.proximoJuros = agoraCredito + PRAZO_CARTAO_MS;
                                contaCompra.cartaoCredito.parcelasTotais = parcelasEscolhidas > 1 ? parcelasEscolhidas : 0;
                                contaCompra.cartaoCredito.parcelasPagas = 0;
                                contaCompra.cartaoCredito.valorParcela = parcelasEscolhidas > 1 ? Number((item.preco / parcelasEscolhidas).toFixed(2)) : 0;
                                contaCompra.cartaoCredito.proximaParcela = parcelasEscolhidas > 1 ? agoraCredito + PRAZO_CARTAO_MS : 0;
                                registrarTransacao(dadosGlobais, userGroupKey, 'cartao', item.preco, `Compra no crédito: ${item.nome}`);
                                compraNoCredito = true;
                            } else {
                                if (contaCompra.dinheiro < item.preco) {
                                    return await sock.sendMessage(remoteJid, { text: `💸 Saldo insuficiente.\n\nPreço: *R$ ${item.preco.toFixed(2)}*\nSeu saldo: *R$ ${contaCompra.dinheiro.toFixed(2)}*\n\n💳 Você também pode usar *${prefix}comprar ${itemLoja} credito* se tiver limite disponível.` }, { quoted: m });
                                }
                                contaCompra.dinheiro -= item.preco;
                                registrarTransacao(dadosGlobais, userGroupKey, 'loja', -item.preco, `Compra: ${item.nome}`);
                            }

                            let detalheCompra = '';
                            if (itemLoja === 'protecao') {
                                contaCompra.protecaoRoubo = 1;
                                detalheCompra = '🛡️ Sua proteção está guardada e será usada uma única vez.';
                            } else if (itemLoja === 'titulo') {
                                contaCompra.titulo = 'VIP';
                                detalheCompra = '🏷️ O título *VIP* já está disponível no seu perfil.';
                            } else if (['kitxp', 'kitxp60', 'kitxp100'].includes(itemLoja)) {
                                const quantidadeXPKit = itemLoja === 'kitxp100' ? 100 : itemLoja === 'kitxp60' ? 60 : 30;
                                const statsKit = obterStatsXP(userGroupKey);
                                const antesNivelKit = statsKit.nivel;
                                const ganhouKit = aplicarXP(statsKit, quantidadeXPKit);
                                const recompensaKit = ganhouKit > 0 ? adicionarRecompensaNivel(userGroupKey, antesNivelKit, statsKit.nivel) : 0;
                                garantirProgressoJogador(dadosGlobais, userGroupKey).xpGanho += quantidadeXPKit;
                                detalheCompra = `✨ +${quantidadeXPKit} XP aplicados. Nível: *${statsKit.nivel}*` + (recompensaKit > 0 ? `\n💰 Recompensa de nível: *R$ ${recompensaKit.toFixed(2)}*` : '');
                            }

                            const progCompra = garantirProgressoJogador(dadosGlobais, userGroupKey);
                            progCompra.compras += 1;
                            const missaoCompraConcluida = registrarMissao(dadosGlobais, userGroupKey, 'compras', 1);
                            aplicarXPPendenteDasMissoes(userGroupKey);
                            adicionarPontosTemporadaSemValidacao(dadosGlobais, remoteJid, userGroupKey, 2);
                            const conquistasCompra = verificarConquistas(dadosGlobais, remoteJid, userGroupKey);
                            await salvarDadosBot(dadosGlobais);

                            return await sock.sendMessage(remoteJid, {
                                text: `✅ *COMPRA REALIZADA!*\n\n🛒 ${item.nome}\n${compraNoCredito ? `💳 Forma: *CRÉDITO*\n🧾 Dívida criada: *R$ ${contaCompra.cartaoCredito.divida.toFixed(2)}*\n${parcelasEscolhidas > 1 ? `📊 Parcelamento: *${parcelasEscolhidas}x de R$ ${contaCompra.cartaoCredito.valorParcela.toFixed(2)}*\n⏱️ Primeira parcela: *5 minutos*` : '⏱️ Vencimento: *5 minutos*'}` : `💵 Pago: *R$ ${item.preco.toFixed(2)}*\n💰 Saldo anterior: *R$ ${saldoAntesCompra.toFixed(2)}*\n💰 Saldo atual: *R$ ${contaCompra.dinheiro.toFixed(2)}*`}\n\n${detalheCompra}` +
                                      (missaoCompraConcluida ? '\n🎯 *Missão diária concluída!*' : '') +
                                      (conquistasCompra.length ? `\n🏆 Novas conquistas: *${conquistasCompra.length}*` : ''),
                            }, { quoted: m });
                        }

                        case 'pix':
                        case 'transferir': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) return await sock.sendMessage(remoteJid, { text: `🏦 Cadastre-se primeiro com *${prefix}cadastrarbanco*.` }, { quoted: m });
                            const alvoPix = await obterMencionado(corpoMsg, m);
                            if (!alvoPix) return await sock.sendMessage(remoteJid, { text: `❌ Marque quem receberá o PIX. Ex.: *${prefix}pix @pessoa 500*` }, { quoted: m });
                            const alvoPixCanonico = await resolverJidCanonicoGrupo(remoteJid, alvoPix);
                            if (normalizarJid(alvoPixCanonico) === normalizarJid(senderCanonico)) return await sock.sendMessage(remoteJid, { text: '❌ Você não pode fazer PIX para si mesmo.' }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, alvoPixCanonico)) return await sock.sendMessage(remoteJid, { text: '❌ O destinatário precisa ter cadastro no Banco.' }, { quoted: m });
                            const valorPix = Number(String(args[args.length - 1] || '').replace(',', '.'));
                            if (!Number.isFinite(valorPix) || valorPix <= 0) return await sock.sendMessage(remoteJid, { text: `❌ Valor inválido. Ex.: *${prefix}pix @pessoa 500*` }, { quoted: m });

                            const chaveDestPix = chaveCadastroBanco(remoteJid, alvoPixCanonico);
                            const contaOrigemPix = garantirEconomia(dadosGlobais, userGroupKey);
                            const contaDestPix = garantirEconomia(dadosGlobais, chaveDestPix);
                            if (contaOrigemPix.dinheiro < valorPix) return await sock.sendMessage(remoteJid, { text: `💸 Você não possui saldo suficiente.\nSaldo: *R$ ${contaOrigemPix.dinheiro.toFixed(2)}*` }, { quoted: m });

                            contaOrigemPix.dinheiro -= valorPix;
                            contaDestPix.dinheiro += valorPix;
                            registrarTransacao(dadosGlobais, userGroupKey, 'pix', -valorPix, `PIX enviado para @${normalizarJid(alvoPixCanonico)}`);
                            registrarTransacao(dadosGlobais, chaveDestPix, 'pix', valorPix, `PIX recebido de @${cleanSender}`);
                            garantirProgressoJogador(dadosGlobais, userGroupKey).pix += 1;
                            const missaoPixConcluida = registrarMissao(dadosGlobais, userGroupKey, 'pix', 1);
                            aplicarXPPendenteDasMissoes(userGroupKey);
                            adicionarPontosTemporadaSemValidacao(dadosGlobais, remoteJid, userGroupKey, 3);
                            const conquistasPix = verificarConquistas(dadosGlobais, remoteJid, userGroupKey);
                            await salvarDadosBot(dadosGlobais);
                            return await sock.sendMessage(remoteJid, {
                                text: `💸 *PIX REALIZADO!*\n\n` +
                                      `👤 Para: @${normalizarJid(alvoPixCanonico)}\n` +
                                      `💰 Valor: *R$ ${valorPix.toFixed(2)}*\n` +
                                      `💵 Seu novo saldo: *R$ ${contaOrigemPix.dinheiro.toFixed(2)}*` +
                                      (missaoPixConcluida ? '\n🎯 *Missão diária concluída!*' : '') +
                                      (conquistasPix.length ? `\n🏆 Novas conquistas: *${conquistasPix.length}*` : ''),
                                mentions: [alvoPixCanonico]
                            }, { quoted: m });
                        }

                        case 'depositar':
                        case 'deposito': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) return await sock.sendMessage(remoteJid, { text: `🏦 Cadastre-se primeiro com *${prefix}cadastrarbanco*.` }, { quoted: m });
                            const contaDep = garantirEconomia(dadosGlobais, userGroupKey);
                            const textoDep = String(args[0] || '').toLowerCase();
                            let valorDep = textoDep === 'tudo' ? contaDep.dinheiro : Number(textoDep.replace(',', '.'));
                            if (!Number.isFinite(valorDep) || valorDep <= 0) return await sock.sendMessage(remoteJid, { text: `❌ Valor inválido. Ex.: *${prefix}depositar 500* ou *${prefix}depositar tudo*` }, { quoted: m });
                            valorDep = Math.min(valorDep, contaDep.dinheiro);
                            contaDep.dinheiro -= valorDep;
                            contaDep.poupanca += valorDep;
                            registrarTransacao(dadosGlobais, userGroupKey, 'poupanca', -valorDep, 'Depósito na poupança');
                            await salvarDadosBot(dadosGlobais);
                            return await sock.sendMessage(remoteJid, { text: `🏦 *DEPÓSITO REALIZADO!*

💵 Depositado: *R$ ${valorDep.toFixed(2)}*
💰 Conta: *R$ ${contaDep.dinheiro.toFixed(2)}*
🏦 Poupança: *R$ ${contaDep.poupanca.toFixed(2)}*` }, { quoted: m });
                        }

                        case 'sacar':
                        case 'saque': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) return await sock.sendMessage(remoteJid, { text: `🏦 Cadastre-se primeiro com *${prefix}cadastrarbanco*.` }, { quoted: m });
                            const contaSaq = garantirEconomia(dadosGlobais, userGroupKey);
                            const textoSaq = String(args[0] || '').toLowerCase();
                            let valorSaq = textoSaq === 'tudo' ? contaSaq.poupanca : Number(textoSaq.replace(',', '.'));
                            if (!Number.isFinite(valorSaq) || valorSaq <= 0) return await sock.sendMessage(remoteJid, { text: `❌ Valor inválido. Ex.: *${prefix}sacar 500* ou *${prefix}sacar tudo*` }, { quoted: m });
                            if (valorSaq > contaSaq.poupanca) return await sock.sendMessage(remoteJid, { text: `🏦 Você não possui esse valor na poupança.\nSaldo da poupança: *R$ ${contaSaq.poupanca.toFixed(2)}*` }, { quoted: m });
                            contaSaq.poupanca -= valorSaq;
                            contaSaq.dinheiro += valorSaq;
                            registrarTransacao(dadosGlobais, userGroupKey, 'poupanca', valorSaq, 'Saque da poupança');
                            await salvarDadosBot(dadosGlobais);
                            return await sock.sendMessage(remoteJid, { text: `🏦 *SAQUE REALIZADO!*

💵 Sacado: *R$ ${valorSaq.toFixed(2)}*
💰 Conta: *R$ ${contaSaq.dinheiro.toFixed(2)}*
🏦 Poupança: *R$ ${contaSaq.poupanca.toFixed(2)}*` }, { quoted: m });
                        }

                        case 'aumentarlimite':
                        case 'aumentarcredito':
                        case 'pedirlimite': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) {
                                return await sock.sendMessage(remoteJid, { text: `🏦 Cadastre-se primeiro com *${prefix}cadastrarbanco*.` }, { quoted: m });
                            }

                            const contaAumento = garantirEconomia(dadosGlobais, userGroupKey);
                            const cardAumento = contaAumento.cartaoCredito;
                            const limiteAtualAumento = garantirLimiteCartao(contaAumento);

                            if (cardAumento.status === 'cancelado' || cardAumento.nomeSujo) {
                                return await sock.sendMessage(remoteJid, {
                                    text:
                                        `🚫 *SOLICITAÇÃO NEGADA*\n\n` +
                                        `Seu cartão está cancelado por inadimplência.\n` +
                                        `🧾 Dívida atual: *R$ ${Number(cardAumento.divida || 0).toFixed(2)}*\n` +
                                        `Quite tudo com *${prefix}pagarcartao tudo* para reativar.`
                                }, { quoted: m });
                            }

                            if (Number(cardAumento.divida) > 0) {
                                return await sock.sendMessage(remoteJid, {
                                    text:
                                        `❌ Não é possível analisar aumento enquanto houver dívida no cartão.\n\n` +
                                        `🧾 Dívida: *R$ ${Number(cardAumento.divida).toFixed(2)}*\n` +
                                        `Use *${prefix}pagarcartao tudo* para quitar tudo.`
                                }, { quoted: m });
                            }

                            if ((Number(cardAumento.pagamentosEmDia) || 0) < 1) {
                                return await sock.sendMessage(remoteJid, {
                                    text:
                                        `ℹ️ Ainda não há histórico suficiente.\n\n` +
                                        `Pague pelo menos uma fatura inteira em dia e depois use *${prefix}aumentarlimite*.`
                                }, { quoted: m });
                            }

                            if (limiteAtualAumento >= LIMITE_CARTAO_MAXIMO) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `🏆 Seu limite já atingiu o máximo de *R$ ${LIMITE_CARTAO_MAXIMO.toFixed(2)}*.`
                                }, { quoted: m });
                            }

                            const agoraAumento = Date.now();
                            const ultimoPedido = Number(cardAumento.ultimoPedidoAumento) || 0;
                            const intervaloPedidoAumento = 10 * 60 * 1000;
                            if (agoraAumento - ultimoPedido < intervaloPedidoAumento) {
                                const falta = Math.ceil((intervaloPedidoAumento - (agoraAumento - ultimoPedido)) / 1000);
                                return await sock.sendMessage(remoteJid, {
                                    text: `⏳ Uma nova análise só pode ser pedida em aproximadamente *${falta}s*.`
                                }, { quoted: m });
                            }

                            cardAumento.ultimoPedidoAumento = agoraAumento;

                            if (Math.random() < CHANCE_AUMENTO_LIMITE_CARTAO) {
                                const novoLimite = Math.min(LIMITE_CARTAO_MAXIMO, limiteAtualAumento + AUMENTO_LIMITE_CARTAO);
                                cardAumento.limite = novoLimite;
                                cardAumento.aumentosLimite = (Number(cardAumento.aumentosLimite) || 0) + 1;
                                registrarTransacao(
                                    dadosGlobais,
                                    userGroupKey,
                                    'aumento_limite',
                                    0,
                                    `Limite aprovado: R$ ${limiteAtualAumento.toFixed(2)} -> R$ ${novoLimite.toFixed(2)}`
                                );
                                await salvarDadosBot(dadosGlobais);

                                return await sock.sendMessage(remoteJid, {
                                    text:
                                        `🎉 *AUMENTO DE LIMITE APROVADO!*\n\n` +
                                        `💳 Limite anterior: *R$ ${limiteAtualAumento.toFixed(2)}*\n` +
                                        `📈 Aumento: *R$ ${AUMENTO_LIMITE_CARTAO.toFixed(2)}*\n` +
                                        `💳 Novo limite: *R$ ${novoLimite.toFixed(2)}*`
                                }, { quoted: m });
                            }

                            registrarTransacao(
                                dadosGlobais,
                                userGroupKey,
                                'aumento_limite_negado',
                                0,
                                'Solicitação de aumento de limite não aprovada'
                            );
                            await salvarDadosBot(dadosGlobais);

                            return await sock.sendMessage(remoteJid, {
                                text:
                                    `❌ *AUMENTO NÃO APROVADO*\n\n` +
                                    `No momento não há condições para aumentar seu limite.\n` +
                                    `💳 Limite atual: *R$ ${limiteAtualAumento.toFixed(2)}*\n\n` +
                                    `Continue pagando o cartão totalmente em dia e tente novamente depois.`
                            }, { quoted: m });
                        }

                        case 'limite':
                        case 'limiteemprestimo': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) return await sock.sendMessage(remoteJid, { text: `🏦 Cadastre-se primeiro com *${prefix}cadastrarbanco*.` }, { quoted: m });
                            const contaLimite = garantirEconomia(dadosGlobais, userGroupKey);
                            const statsLimite = obterStatsXP(userGroupKey);
                            const limiteEmprestimo = Math.min(10000, Math.max(500, (Number(statsLimite.nivel) || 1) * 400));
                            return await sock.sendMessage(remoteJid, { text: `💳 *LIMITE DE CRÉDITO*\n\n🌟 Nível: *${statsLimite.nivel}*\n💰 Limite disponível: *R$ ${limiteEmprestimo.toFixed(2)}*\n📌 Dívida atual: *R$ ${(Number(contaLimite.emprestimo) || 0).toFixed(2)}*` }, { quoted: m });
                        }

                        case 'emprestimo':
                        case 'loan': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) return await sock.sendMessage(remoteJid, { text: `🏦 Cadastre-se primeiro com *${prefix}cadastrarbanco*.` }, { quoted: m });
                            const contaEmp = garantirEconomia(dadosGlobais, userGroupKey);
                            if (contaEmp.emprestimo > 0) return await sock.sendMessage(remoteJid, { text: `❌ Você já possui uma dívida ativa de *R$ ${contaEmp.emprestimo.toFixed(2)}*. Use *${prefix}pagaremprestimo* para quitar.` }, { quoted: m });
                            const statsEmp = obterStatsXP(userGroupKey);
                            const limiteEmp = Math.min(10000, Math.max(500, (Number(statsEmp.nivel) || 1) * 400));
                            const valorEmp = Number(String(args[0] || '').replace(',', '.'));
                            if (!Number.isFinite(valorEmp) || valorEmp <= 0 || valorEmp > limiteEmp) return await sock.sendMessage(remoteJid, { text: `❌ Valor inválido. Seu limite é *R$ ${limiteEmp.toFixed(2)}*. Ex.: *${prefix}emprestimo 1000*` }, { quoted: m });
                            const jurosEmp = Math.round(valorEmp * 0.05 * 100) / 100;
                            contaEmp.emprestimo = valorEmp + jurosEmp;
                            contaEmp.dinheiro += valorEmp;
                            registrarTransacao(dadosGlobais, userGroupKey, 'emprestimo', valorEmp, `Empréstimo recebido (dívida R$ ${contaEmp.emprestimo.toFixed(2)})`);
                            await salvarDadosBot(dadosGlobais);
                            return await sock.sendMessage(remoteJid, { text: `💳 *EMPRÉSTIMO LIBERADO!*\n\n💰 Recebido: *R$ ${valorEmp.toFixed(2)}*\n📈 Encargos: *R$ ${jurosEmp.toFixed(2)}*\n🧾 Dívida total: *R$ ${contaEmp.emprestimo.toFixed(2)}*\n💵 Saldo atual: *R$ ${contaEmp.dinheiro.toFixed(2)}*\n\nUse *${prefix}pagaremprestimo <valor|tudo>* para pagar.` }, { quoted: m });
                        }

                        case 'pagaremprestimo':
                        case 'quitaremprestimo': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) return await sock.sendMessage(remoteJid, { text: `🏦 Cadastre-se primeiro com *${prefix}cadastrarbanco*.` }, { quoted: m });
                            const contaPag = garantirEconomia(dadosGlobais, userGroupKey);
                            if (contaPag.emprestimo <= 0) return await sock.sendMessage(remoteJid, { text: '✅ Você não possui empréstimo ativo.' }, { quoted: m });
                            const textoPag = String(args[0] || '').toLowerCase();
                            let valorPag = textoPag === 'tudo' ? Math.min(contaPag.dinheiro, contaPag.emprestimo) : Number(textoPag.replace(',', '.'));
                            if (!Number.isFinite(valorPag) || valorPag <= 0) return await sock.sendMessage(remoteJid, { text: `❌ Valor inválido. Dívida atual: *R$ ${contaPag.emprestimo.toFixed(2)}*` }, { quoted: m });
                            if (valorPag > contaPag.dinheiro) return await sock.sendMessage(remoteJid, { text: `💸 Você não possui saldo suficiente. Saldo: *R$ ${contaPag.dinheiro.toFixed(2)}*` }, { quoted: m });
                            valorPag = Math.min(valorPag, contaPag.emprestimo);
                            contaPag.dinheiro -= valorPag;
                            contaPag.emprestimo -= valorPag;
                            if (contaPag.emprestimo < 0.005) contaPag.emprestimo = 0;
                            registrarTransacao(dadosGlobais, userGroupKey, 'emprestimo', -valorPag, 'Pagamento de empréstimo');
                            await salvarDadosBot(dadosGlobais);
                            return await sock.sendMessage(remoteJid, { text: `✅ *PAGAMENTO REGISTRADO!*\n\n💵 Pago: *R$ ${valorPag.toFixed(2)}*\n🧾 Dívida restante: *R$ ${contaPag.emprestimo.toFixed(2)}*\n💰 Saldo: *R$ ${contaPag.dinheiro.toFixed(2)}*` }, { quoted: m });
                        }

                        case 'cartao':
                        case 'credito':
                        case 'cartãodecredito': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) return await sock.sendMessage(remoteJid, { text: `🏦 Cadastre-se primeiro com *${prefix}cadastrarbanco*.` }, { quoted: m });
                            atualizarJurosCartao(dadosGlobais);
                            const contaCartao = garantirEconomia(dadosGlobais, userGroupKey);
                            const limiteCartao = garantirLimiteCartao(contaCartao);
                            const dividaCartao = Number(contaCartao.cartaoCredito.divida) || 0;
                            const disponivelCartao = Math.max(0, limiteCartao - dividaCartao);
                            const parcelado = Number(contaCartao.cartaoCredito.parcelasTotais) > 0;
                            const parcelasRestantes = parcelado ? Math.max(0, Number(contaCartao.cartaoCredito.parcelasTotais) - Number(contaCartao.cartaoCredito.parcelasPagas || 0)) : 0;
                            await salvarDadosBot(dadosGlobais);
                            return await sock.sendMessage(remoteJid, { text: `💳 *CARTÃO DE CRÉDITO*\n\n💰 Limite: *R$ ${limiteCartao.toFixed(2)}*\n💳 Dívida atual: *R$ ${dividaCartao.toFixed(2)}*\n🟢 Disponível: *R$ ${disponivelCartao.toFixed(2)}*\n📈 Pagamentos em dia: *${Number(contaCartao.cartaoCredito.pagamentosEmDia) || 0}*\n${parcelado ? `🧾 Parcelamento: *${parcelasRestantes} parcela(s) restante(s)*\n💵 Valor da parcela: *R$ ${Number(contaCartao.cartaoCredito.valorParcela || 0).toFixed(2)}*\n` : ''}\n📌 Limite inicial: R$ 1.000 | máximo: R$ 10.000. Pagamentos em dia têm *40% de chance* de aumentar o limite em R$ 500.\n⏱️ Compras normais vencem após 5 minutos. Em atraso, juros de 1% a cada 5 segundos, limitados a 2x o valor original.\n\nUse *${prefix}pagarcartao tudo* para quitar ou *${prefix}pagarcartao parcelar 2* / *${prefix}pagarcartao parcelar 3* para parcelar em até 3 vezes.` }, { quoted: m });
                        }

                        case 'pagarcartao':
                        case 'pagarcredito': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) return await sock.sendMessage(remoteJid, { text: `🏦 Cadastre-se primeiro com *${prefix}cadastrarbanco*.` }, { quoted: m });

                            atualizarJurosCartao(dadosGlobais);
                            const contaPagCartao = garantirEconomia(dadosGlobais, userGroupKey);
                            const cartaoPag = contaPagCartao.cartaoCredito;
                            const dividaAtualCartao = Number(cartaoPag.divida) || 0;
                            if (dividaAtualCartao <= 0) return await sock.sendMessage(remoteJid, { text: '✅ Você não possui dívida no cartão de crédito.' }, { quoted: m });

                            const agoraPag = Date.now();
                            const arg0 = String(args[0] || '').toLowerCase();

                            // Inicia parcelamento. A primeira parcela é paga na hora; as seguintes vencem a cada 5 minutos.
                            if (arg0 === 'parcelar') {
                                if (Number(cartaoPag.parcelasTotais) > 0) {
                                    return await sock.sendMessage(remoteJid, { text: '❌ Você já possui um parcelamento ativo. Termine o atual antes de criar outro.' }, { quoted: m });
                                }
                                const parcelas = Number(args[1]);
                                if (!Number.isInteger(parcelas) || parcelas < 2 || parcelas > MAX_PARCELAS_CARTAO) {
                                    return await sock.sendMessage(remoteJid, { text: `❌ Escolha 2 ou 3 parcelas. Ex.: *${prefix}pagarcartao parcelar 3*` }, { quoted: m });
                                }
                                const valorBaseParcela = Number((dividaAtualCartao / parcelas).toFixed(2));
                                const primeiraParcela = valorBaseParcela;
                                if (contaPagCartao.dinheiro < primeiraParcela) {
                                    return await sock.sendMessage(remoteJid, { text: `💸 Saldo insuficiente para a primeira parcela.\n\n💵 Primeira parcela: *R$ ${primeiraParcela.toFixed(2)}*\n💰 Seu saldo: *R$ ${contaPagCartao.dinheiro.toFixed(2)}*` }, { quoted: m });
                                }

                                const eraEmDia = !cartaoPag.jurosInicio || agoraPag <= Number(cartaoPag.jurosInicio);
                                contaPagCartao.dinheiro -= primeiraParcela;
                                cartaoPag.divida = Math.max(0, Number((dividaAtualCartao - primeiraParcela).toFixed(2)));
                                cartaoPag.parcelasTotais = parcelas;
                                cartaoPag.parcelasPagas = 1;
                                cartaoPag.valorParcela = valorBaseParcela;
                                cartaoPag.proximaParcela = agoraPag + PRAZO_CARTAO_MS;
                                cartaoPag.jurosInicio = cartaoPag.proximaParcela;
                                cartaoPag.proximoJuros = cartaoPag.proximaParcela;
                                registrarTransacao(dadosGlobais, userGroupKey, 'pagamento_cartao', -primeiraParcela, `1ª parcela do cartão (${parcelas}x)`);

                                let bonusLimite = 0;
                                if (cartaoPag.divida <= 0.005) {
                                    const resultadoLimite = registrarPagamentoEmDiaCartao(contaPagCartao, eraEmDia);
                                    bonusLimite = resultadoLimite.aumento;
                                    cartaoPag.divida = 0;
                                    cartaoPag.principal = 0;
                                    cartaoPag.parcelasTotais = 0;
                                    cartaoPag.parcelasPagas = 0;
                                    cartaoPag.valorParcela = 0;
                                    cartaoPag.proximaParcela = 0;
                                    cartaoPag.criadoEm = 0;
                                    cartaoPag.jurosInicio = 0;
                                    cartaoPag.proximoJuros = 0;
                                }
                                await salvarDadosBot(dadosGlobais);
                                return await sock.sendMessage(remoteJid, { text: `💳 *PARCELAMENTO INICIADO*\n\n📊 Plano: *${parcelas}x*\n💵 1ª parcela paga: *R$ ${primeiraParcela.toFixed(2)}*\n🧾 Dívida restante: *R$ ${cartaoPag.divida.toFixed(2)}*\n⏱️ Próxima parcela: em *5 minutos*\n${bonusLimite > 0 ? `\n🎉 Pagamento em dia! Seu limite aumentou em *R$ ${bonusLimite.toFixed(2)}*.` : ''}\n\nUse *${prefix}pagarcartao* quando a próxima parcela vencer.` }, { quoted: m });
                            }

                            const parcelado = Number(cartaoPag.parcelasTotais) > 0;
                            if (parcelado) {
                                const parcelasTotais = Number(cartaoPag.parcelasTotais);
                                const parcelasPagas = Number(cartaoPag.parcelasPagas) || 0;
                                if (parcelasPagas >= parcelasTotais || dividaAtualCartao <= 0.005) {
                                    cartaoPag.divida = 0;
                                } else if (agoraPag < Number(cartaoPag.proximaParcela || 0)) {
                                    const faltam = Math.max(1, Math.ceil((Number(cartaoPag.proximaParcela) - agoraPag) / 1000));
                                    return await sock.sendMessage(remoteJid, { text: `⏳ A próxima parcela ainda não venceu. Aguarde aproximadamente *${faltam}s*.` }, { quoted: m });
                                } else {
                                    const ultimaParcela = parcelasPagas + 1 >= parcelasTotais;
                                    const valorParcela = ultimaParcela
                                        ? Number(dividaAtualCartao.toFixed(2))
                                        : Math.min(Number(cartaoPag.valorParcela || 0), dividaAtualCartao);
                                    if (contaPagCartao.dinheiro < valorParcela) {
                                        return await sock.sendMessage(remoteJid, { text: `💸 Você não tem saldo suficiente para a parcela.\n\n💵 Parcela: *R$ ${valorParcela.toFixed(2)}*\n💰 Saldo: *R$ ${contaPagCartao.dinheiro.toFixed(2)}*` }, { quoted: m });
                                    }
                                    const eraEmDia = agoraPag <= Number(cartaoPag.proximaParcela || agoraPag);
                                    contaPagCartao.dinheiro -= valorParcela;
                                    cartaoPag.divida = Math.max(0, Number((dividaAtualCartao - valorParcela).toFixed(2)));
                                    cartaoPag.parcelasPagas = parcelasPagas + 1;
                                    registrarTransacao(dadosGlobais, userGroupKey, 'pagamento_cartao', -valorParcela, `${cartaoPag.parcelasPagas}ª parcela do cartão (${parcelasTotais}x)`);

                                    let bonusLimite = 0;
                                    if (cartaoPag.divida <= 0.005 || cartaoPag.parcelasPagas >= parcelasTotais) {
                                        const resultadoLimite = registrarPagamentoEmDiaCartao(contaPagCartao, eraEmDia);
                                        bonusLimite = resultadoLimite.aumento;
                                        cartaoPag.divida = 0;
                                        cartaoPag.principal = 0;
                                        cartaoPag.parcelasTotais = 0;
                                        cartaoPag.parcelasPagas = 0;
                                        cartaoPag.valorParcela = 0;
                                        cartaoPag.proximaParcela = 0;
                                        cartaoPag.criadoEm = 0;
                                        cartaoPag.jurosInicio = 0;
                                        cartaoPag.proximoJuros = 0;
                                    } else {
                                        cartaoPag.proximaParcela = agoraPag + PRAZO_CARTAO_MS;
                                        cartaoPag.jurosInicio = cartaoPag.proximaParcela;
                                        cartaoPag.proximoJuros = cartaoPag.proximaParcela;
                                    }
                                    await salvarDadosBot(dadosGlobais);
                                    return await sock.sendMessage(remoteJid, { text: `💳 *PARCELA PAGA*\n\n💵 Pago: *R$ ${valorParcela.toFixed(2)}*\n📊 Parcela: *${cartaoPag.parcelasPagas || parcelasTotais}/${parcelasTotais}*\n🧾 Dívida restante: *R$ ${cartaoPag.divida.toFixed(2)}*\n💰 Saldo: *R$ ${contaPagCartao.dinheiro.toFixed(2)}*\n${cartaoPag.divida > 0 ? `⏱️ Próxima parcela: em *5 minutos*` : '✅ Cartão quitado.'}${bonusLimite > 0 ? `\n🎉 Limite aumentado em *R$ ${bonusLimite.toFixed(2)}*!` : ''}` }, { quoted: m });
                                }
                            }

                            const valorTextoCartao = String(args[0] || '').toLowerCase();
                            let valorPagamentoCartao = valorTextoCartao === 'tudo' ? Math.min(contaPagCartao.dinheiro, dividaAtualCartao) : Number(valorTextoCartao.replace(',', '.'));
                            if (!Number.isFinite(valorPagamentoCartao) || valorPagamentoCartao <= 0) {
                                return await sock.sendMessage(remoteJid, { text: `❌ Informe um valor, use *tudo* ou parcele: *${prefix}pagarcartao parcelar 2* / *${prefix}pagarcartao parcelar 3*.\n🧾 Dívida atual: *R$ ${dividaAtualCartao.toFixed(2)}*` }, { quoted: m });
                            }
                            valorPagamentoCartao = Math.min(valorPagamentoCartao, dividaAtualCartao, contaPagCartao.dinheiro);
                            const eraEmDia = !cartaoPag.jurosInicio || agoraPag <= Number(cartaoPag.jurosInicio);
                            contaPagCartao.dinheiro -= valorPagamentoCartao;
                            cartaoPag.divida = Math.max(0, Number((dividaAtualCartao - valorPagamentoCartao).toFixed(2)));

                            let bonusLimite = 0;
                            if (cartaoPag.divida <= 0.005) {
                                const resultadoLimite = registrarPagamentoEmDiaCartao(contaPagCartao, eraEmDia);
                                bonusLimite = resultadoLimite.aumento;
                                cartaoPag.divida = 0;
                                cartaoPag.principal = 0;
                                cartaoPag.criadoEm = 0;
                                cartaoPag.jurosInicio = 0;
                                cartaoPag.proximoJuros = 0;
                                cartaoPag.parcelasTotais = 0;
                                cartaoPag.parcelasPagas = 0;
                                cartaoPag.valorParcela = 0;
                                cartaoPag.proximaParcela = 0;
                            }
                            registrarTransacao(dadosGlobais, userGroupKey, 'pagamento_cartao', -valorPagamentoCartao, 'Pagamento do cartão de crédito');
                            await salvarDadosBot(dadosGlobais);
                            return await sock.sendMessage(remoteJid, { text: `💳 *PAGAMENTO DO CARTÃO*\n\n💵 Pago: *R$ ${valorPagamentoCartao.toFixed(2)}*\n🧾 Dívida restante: *R$ ${cartaoPag.divida.toFixed(2)}*\n💰 Saldo: *R$ ${contaPagCartao.dinheiro.toFixed(2)}*${bonusLimite > 0 ? `\n🎉 Pagamento em dia! Seu limite aumentou em *R$ ${bonusLimite.toFixed(2)}*.` : ''}` }, { quoted: m });
                        }

                        case 'extrato':
                        case 'historico': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) return await sock.sendMessage(remoteJid, { text: `🏦 Cadastre-se primeiro com *${prefix}cadastrarbanco*.` }, { quoted: m });
                            const contaExt = garantirEconomia(dadosGlobais, userGroupKey);
                            const extratos = (dadosGlobais.transacoes?.[userGroupKey] || []).slice(0, 10);
                            const linhasExtrato = extratos.length
                                ? extratos.map((t) => {
                                    const valor = Number(t.valor) || 0;
                                    const sinal = valor >= 0 ? '+' : '-';
                                    return `${sinal} R$ ${Math.abs(valor).toFixed(2)} — ${t.descricao}`;
                                  }).join('\n')
                                : 'Nenhuma movimentação registrada ainda.';
                            return await sock.sendMessage(remoteJid, {
                                text: `🧾 *EXTRATO BANCÁRIO*\n\n💰 Conta: *R$ ${contaExt.dinheiro.toFixed(2)}*\n🏦 Poupança: *R$ ${contaExt.poupanca.toFixed(2)}*\n🛡️ Proteção: *${contaExt.protecaoRoubo > 0 ? '1 disponível' : '0'}*\n\n*Últimas movimentações:*\n${linhasExtrato}`
                            }, { quoted: m });
                        }

                        case 'conquistas':
                        case 'achievements': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) return await sock.sendMessage(remoteJid, { text: `🏦 Cadastre-se primeiro com *${prefix}cadastrarbanco*.` }, { quoted: m });
                            const chaveConq = userGroupKey;
                            const novasConq = verificarConquistas(dadosGlobais, remoteJid, chaveConq);
                            if (novasConq.length) await salvarDadosBot(dadosGlobais);
                            const liberadas = dadosGlobais.conquistas?.[chaveConq] || {};
                            const linhasConq = Object.entries(DEFINICOES_CONQUISTAS).map(([id, c]) => `${liberadas[id] ? '✅' : '🔒'} *${c.nome}* — ${c.descricao}`).join('\n');
                            return await sock.sendMessage(remoteJid, {
                                text: `🏆 *CONQUISTAS*\n\n${linhasConq}\n\n✅ Desbloqueadas: *${Object.keys(liberadas).length}/${Object.keys(DEFINICOES_CONQUISTAS).length}*`
                            }, { quoted: m });
                        }

                        case 'temporada':
                        case 'season': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) return await sock.sendMessage(remoteJid, { text: `🏦 Cadastre-se primeiro com *${prefix}cadastrarbanco*.` }, { quoted: m });
                            const resTemp = garantirTemporadaGrupo(dadosGlobais, remoteJid);
                            const temp = resTemp.temp;
                            const rankingTemp = Object.entries(temp.pontos || {})
                                .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
                                .slice(0, 10);
                            const linhasTemp = rankingTemp.length
                                ? rankingTemp.map((entry, i) => `${['🥇','🥈','🥉'][i] || `${i + 1}º`} @${normalizarJid(entry[0].slice(remoteJid.length + 1))} — *${Number(entry[1]) || 0} pontos*`).join('\n')
                                : 'Ainda não há pontos nesta temporada.';
                            if (resTemp.alterou) await salvarDadosBot(dadosGlobais);
                            return await sock.sendMessage(remoteJid, { text: `🏆 *TEMPORADA ${temp.id}*\n\n${linhasTemp}\n\n📌 Pontos: mensagens +1, trabalho +5, daily +10, loja +2, PIX +3, duelo +10 (vitória).` }, { quoted: m });
                        }

                        case 'duelo':
                        case 'duelar': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, senderCanonico)) return await sock.sendMessage(remoteJid, { text: `🏦 Cadastre-se primeiro com *${prefix}cadastrarbanco*.` }, { quoted: m });

                            const alvoDuelo = await obterMencionado(corpoMsg, m);
                            if (!alvoDuelo) return await sock.sendMessage(remoteJid, { text: `❌ Marque alguém para desafiar. Ex.: *${prefix}duelo @pessoa 50*` }, { quoted: m });
                            const alvoDueloCanonico = await resolverJidCanonicoGrupo(remoteJid, alvoDuelo);
                            if (normalizarJid(alvoDueloCanonico) === normalizarJid(senderCanonico)) return await sock.sendMessage(remoteJid, { text: '❌ Você não pode duelar consigo mesmo.' }, { quoted: m });
                            if (!bancoCadastrado(dadosGlobais, remoteJid, alvoDueloCanonico)) return await sock.sendMessage(remoteJid, { text: '❌ O outro jogador também precisa ter cadastro no Banco.' }, { quoted: m });

                            const valorApostaDuelo = args.length > 0 ? Number(String(args[args.length - 1]).replace(',', '.')) : 0;
                            if (!Number.isFinite(valorApostaDuelo) || valorApostaDuelo < 0) return await sock.sendMessage(remoteJid, { text: '❌ Valor de aposta inválido.' }, { quoted: m });
                            const valorDuelo = Math.round(valorApostaDuelo * 100) / 100;

                            // Só pode existir um desafio pendente para o jogador alvo neste grupo.
                            const chaveAlvoDuelo = chaveCadastroBanco(remoteJid, alvoDueloCanonico);
                            if (duelosPendentes[chaveAlvoDuelo]) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `❌ @${normalizarJid(alvoDueloCanonico)} já possui um duelo pendente neste grupo.`,
                                    mentions: [alvoDueloCanonico]
                                }, { quoted: m });
                            }

                            const contaDesafiante = garantirEconomia(dadosGlobais, userGroupKey);
                            const contaAlvo = garantirEconomia(dadosGlobais, chaveAlvoDuelo);
                            const disponivelDesafiante = Number(contaDesafiante.dinheiro) + Math.max(0, garantirLimiteCartao(contaDesafiante) - Number(contaDesafiante.cartaoCredito.divida || 0));
                            const disponivelAlvo = Number(contaAlvo.dinheiro) + Math.max(0, garantirLimiteCartao(contaAlvo) - Number(contaAlvo.cartaoCredito.divida || 0));

                            if (valorDuelo > 0 && (disponivelDesafiante < valorDuelo || disponivelAlvo < valorDuelo)) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `💸 O duelo de *R$ ${valorDuelo.toFixed(2)}* só pode ser iniciado se os dois jogadores tiverem o valor disponível entre saldo e crédito.\n\n💰 Seu disponível: *R$ ${disponivelDesafiante.toFixed(2)}*\n💰 Disponível do adversário: *R$ ${disponivelAlvo.toFixed(2)}*\n\n💡 Se quiser um duelo sem aposta, use *${prefix}duelo @pessoa 0*.`
                                }, { quoted: m });
                            }

                            const dueloPendente = {
                                grupo: remoteJid,
                                desafiante: senderCanonico,
                                alvo: alvoDueloCanonico,
                                aposta: valorDuelo,
                                criadoEm: Date.now()
                            };

                            duelosPendentes[chaveAlvoDuelo] = dueloPendente;

                            // O timeout é identificado pelo chat + alvo. Assim,
                            // um desafio de outro grupo nunca cancela este.
                            if (temporizadoresDuelos[chaveAlvoDuelo]) {
                                clearTimeout(temporizadoresDuelos[chaveAlvoDuelo]);
                            }

                            temporizadoresDuelos[chaveAlvoDuelo] = setTimeout(async () => {
                                const pendenteAtual = duelosPendentes[chaveAlvoDuelo];

                                // Só expira se ainda for exatamente este desafio.
                                if (!pendenteAtual || pendenteAtual !== dueloPendente || pendenteAtual.grupo !== remoteJid) return;

                                delete duelosPendentes[chaveAlvoDuelo];
                                delete temporizadoresDuelos[chaveAlvoDuelo];

                                try {
                                    await sock.sendMessage(remoteJid, {
                                        text: `⏱️ *DUELO ENCERRADO!*\n\nNinguém respondeu ao desafio de @${normalizarJid(dueloPendente.alvo)} em até 60 segundos.\n\n❌ O duelo foi cancelado por falta de resposta.\n💰 Nenhuma aposta foi descontada de ninguém.`,
                                        mentions: [dueloPendente.desafiante, dueloPendente.alvo]
                                    });
                                } catch (err) {}
                            }, 60000);

                            return await sock.sendMessage(remoteJid, {
                                text: `⚔️ *DESAFIO DE DUELO!*\n\n@${normalizarJid(senderCanonico)} desafiou @${normalizarJid(alvoDueloCanonico)}!\n\n💰 Aposta: *R$ ${valorDuelo.toFixed(2)}*${valorDuelo > 0 ? ' para cada jogador' : ' — sem aposta'}\n\n@${normalizarJid(alvoDueloCanonico)}, use *${prefix}aceitar* em até 60 segundos.\n❌ Se não quiser participar, use *${prefix}recusar*.\n\n📌 O desafiante também pode desistir usando *${prefix}recusar* antes do aceite.\n\n📊 O nível influencia bastante a chance de vitória, mas o jogador de nível menor ainda pode vencer.`,
                                mentions: [senderCanonico, alvoDueloCanonico]
                            }, { quoted: m });
                        }

                        case 'recusar': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });

                            const chaveRecusaAlvo = userGroupKey;
                            const dueloRecebido = duelosPendentes[chaveRecusaAlvo];

                            // O desafiante pode desistir procurando um desafio
                            // pendente que ele mesmo criou neste mesmo grupo.
                            let chaveRecusaDesafiante = null;
                            let dueloCriadoPeloUsuario = null;

                            for (const [chave, dueloPendente] of Object.entries(duelosPendentes)) {
                                if (
                                    dueloPendente &&
                                    dueloPendente.grupo === remoteJid &&
                                    normalizarJid(dueloPendente.desafiante) === normalizarJid(senderCanonico)
                                ) {
                                    chaveRecusaDesafiante = chave;
                                    dueloCriadoPeloUsuario = dueloPendente;
                                    break;
                                }
                            }

                            // Se quem recusou é o desafiado, cancela o duelo recebido.
                            if (dueloRecebido && dueloRecebido.grupo === remoteJid) {
                                delete duelosPendentes[chaveRecusaAlvo];

                                if (temporizadoresDuelos[chaveRecusaAlvo]) {
                                    clearTimeout(temporizadoresDuelos[chaveRecusaAlvo]);
                                    delete temporizadoresDuelos[chaveRecusaAlvo];
                                }

                                return await sock.sendMessage(remoteJid, {
                                    text: `❌ *DUELO RECUSADO!*\n\n@${normalizarJid(senderCanonico)} recusou o desafio de @${normalizarJid(dueloRecebido.desafiante)}.\n\n💰 A aposta de *R$ ${Number(dueloRecebido.aposta || 0).toFixed(2)}* não foi descontada de ninguém.`,
                                    mentions: [senderCanonico, dueloRecebido.desafiante]
                                }, { quoted: m });
                            }

                            // Se quem recusou é o desafiante, ele pode desistir.
                            if (dueloCriadoPeloUsuario && chaveRecusaDesafiante) {
                                delete duelosPendentes[chaveRecusaDesafiante];

                                if (temporizadoresDuelos[chaveRecusaDesafiante]) {
                                    clearTimeout(temporizadoresDuelos[chaveRecusaDesafiante]);
                                    delete temporizadoresDuelos[chaveRecusaDesafiante];
                                }

                                return await sock.sendMessage(remoteJid, {
                                    text: `❌ *DUELO CANCELADO!*\n\n@${normalizarJid(senderCanonico)} desistiu do duelo antes de @${normalizarJid(dueloCriadoPeloUsuario.alvo)} aceitar.\n\n💰 A aposta de *R$ ${Number(dueloCriadoPeloUsuario.aposta || 0).toFixed(2)}* não foi descontada de ninguém.`,
                                    mentions: [senderCanonico, dueloCriadoPeloUsuario.alvo]
                                }, { quoted: m });
                            }

                            return await sock.sendMessage(remoteJid, {
                                text: '❌ Você não possui um duelo pendente neste grupo para recusar.'
                            }, { quoted: m });
                        }

                        case 'aceitar':
                        case 'aceiteduelo': {
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Comando só para grupos.' }, { quoted: m });
                            if (!dadosGlobais.brincadeiras?.[remoteJid]) return await sock.sendMessage(remoteJid, { text: `🔒 As brincadeiras estão desativadas neste grupo. Um administrador pode ativá-las com *${prefix}brincadeiras1*.` }, { quoted: m });
                            const chaveAceite = userGroupKey;
                            const duelo = duelosPendentes[chaveAceite];
                            if (!duelo || duelo.grupo !== remoteJid) return await sock.sendMessage(remoteJid, { text: '❌ Você não possui um duelo pendente.' }, { quoted: m });
                            if (normalizarJid(duelo.alvo || '') !== normalizarJid(senderCanonico)) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Somente a pessoa desafiada pode aceitar este duelo.' }, { quoted: m });
                            }
                            if (Date.now() - duelo.criadoEm > 60000) {
                                delete duelosPendentes[chaveAceite];
                                return await sock.sendMessage(remoteJid, { text: '⏱️ Esse desafio expirou.' }, { quoted: m });
                            }

                            const chaveDesafianteDuelo = chaveCadastroBanco(remoteJid, duelo.desafiante);
                            if (!bancoCadastrado(dadosGlobais, remoteJid, duelo.desafiante)) return await sock.sendMessage(remoteJid, { text: '❌ O desafiante não está mais cadastrado.' }, { quoted: m });
                            const contaApostaA = garantirEconomia(dadosGlobais, chaveDesafianteDuelo);
                            const contaApostaB = garantirEconomia(dadosGlobais, chaveAceite);
                            const apostaDuelo = Math.max(0, Number(duelo.aposta) || 0);

                            // O duelo com aposta exige que os dois tenham o valor disponível.
                            // O saldo é usado primeiro; somente o restante é lançado no crédito.
                            function reservarValorDuelo(conta, valor) {
                                if (valor <= 0) return { ok: true, usadoSaldo: 0, usadoCredito: 0 };
                                const saldo = Math.max(0, Number(conta.dinheiro) || 0);
                                const usarSaldo = Math.min(saldo, valor);
                                const faltante = Number((valor - usarSaldo).toFixed(2));
                                const limite = garantirLimiteCartao(conta);
                                const divida = Math.max(0, Number(conta.cartaoCredito.divida) || 0);
                                const disponivelCredito = Math.max(0, limite - divida);
                                if (faltante > disponivelCredito + 0.005) return { ok: false, usadoSaldo: 0, usadoCredito: 0 };
                                conta.dinheiro = Number((saldo - usarSaldo).toFixed(2));
                                if (faltante > 0) {
                                    conta.cartaoCredito.divida = Number((divida + faltante).toFixed(2));
                                    conta.cartaoCredito.principal = Number((Math.max(Number(conta.cartaoCredito.principal) || 0, conta.cartaoCredito.divida)).toFixed(2));
                                    const agora = Date.now();
                                    conta.cartaoCredito.criadoEm = agora;
                                    conta.cartaoCredito.jurosInicio = agora + PRAZO_CARTAO_MS;
                                    conta.cartaoCredito.proximoJuros = agora + PRAZO_CARTAO_MS;
                                }
                                return { ok: true, usadoSaldo: usarSaldo, usadoCredito: faltante };
                            }

                            if (apostaDuelo > 0) {
                                // Revalida no momento da aceitação para impedir gasto simultâneo/alteração de saldo.
                                const reservaA = reservarValorDuelo(contaApostaA, apostaDuelo);
                                const reservaB = reservarValorDuelo(contaApostaB, apostaDuelo);
                                if (!reservaA.ok || !reservaB.ok) {
                                    // Se a segunda reserva falhar, desfaz a primeira.
                                    if (reservaA.ok) {
                                        contaApostaA.dinheiro = Number((contaApostaA.dinheiro + reservaA.usadoSaldo).toFixed(2));
                                        if (reservaA.usadoCredito > 0) contaApostaA.cartaoCredito.divida = Math.max(0, Number((contaApostaA.cartaoCredito.divida - reservaA.usadoCredito).toFixed(2)));
                                    }
                                    delete duelosPendentes[chaveAceite];
                                    return await sock.sendMessage(remoteJid, { text: '❌ O duelo não pôde ser realizado porque um dos jogadores não possui saldo/crédito suficiente para cobrir a aposta.' }, { quoted: m });
                                }
                                registrarTransacao(dadosGlobais, chaveDesafianteDuelo, 'duelo_aposta', -apostaDuelo, 'Valor reservado para duelo');
                                registrarTransacao(dadosGlobais, chaveAceite, 'duelo_aposta', -apostaDuelo, 'Valor reservado para duelo');
                            }
                            delete duelosPendentes[chaveAceite];
                            if (temporizadoresDuelos[chaveAceite]) {
                                clearTimeout(temporizadoresDuelos[chaveAceite]);
                                delete temporizadoresDuelos[chaveAceite];
                            }

                            const statsA = obterStatsXP(chaveDesafianteDuelo);
                            const statsB = obterStatsXP(chaveAceite);
                            const nivelA = Number(statsA.nivel) || 1;
                            const nivelB = Number(statsB.nivel) || 1;
                            const xpA = Number(statsA.xp) || 0;
                            const xpB = Number(statsB.xp) || 0;
                            const poderBaseA = (nivelA * 100) + xpA;
                            const poderBaseB = (nivelB * 100) + xpB;
                            const chanceA = Math.max(
                                DUELO_CHANCE_MIN_VITORIA,
                                Math.min(
                                    DUELO_CHANCE_MAX_VITORIA,
                                    DUELO_CHANCE_MIN_VITORIA +
                                    (DUELO_BONUS_NIVEL * (poderBaseA / Math.max(1, poderBaseA + poderBaseB)))
                                )
                            );
                            const vencedor = Math.random() < chanceA ? duelo.desafiante : senderCanonico;
                            const perdedor = vencedor === duelo.desafiante ? senderCanonico : duelo.desafiante;
                            const chaveVencedor = chaveCadastroBanco(remoteJid, vencedor);
                            const chavePerdedor = chaveCadastroBanco(remoteJid, perdedor);
                            const contaVencedor = garantirEconomia(dadosGlobais, chaveVencedor);
                            const premioAposta = apostaDuelo * 2;
                            if (apostaDuelo > 0) {
                                contaVencedor.dinheiro += premioAposta;
                                registrarTransacao(dadosGlobais, chaveVencedor, 'duelo_aposta', premioAposta, 'Prêmio de aposta do duelo');
                            }

                            let recompensaPerdedor = 0;
                            if (apostaDuelo > 0 && Math.random() < DUELO_CHANCE_RECOMPENSA_PERDEDOR) {
                                const contaPerdedor = garantirEconomia(dadosGlobais, chavePerdedor);
                                contaPerdedor.dinheiro += DUELO_RECOMPENSA_PERDEDOR;
                                recompensaPerdedor = DUELO_RECOMPENSA_PERDEDOR;
                                registrarTransacao(dadosGlobais, chavePerdedor, 'duelo_recompensa', recompensaPerdedor, 'Pequena recompensa de consolação do duelo');
                            }

                            const statsVencedor = obterStatsXP(chaveVencedor);
                            const nivelAntesDuelo = statsVencedor.nivel;
                            const xpGanhoDuelo = aplicarXP(statsVencedor, 50);
                            const recompensaNivelDuelo = xpGanhoDuelo > 0 ? adicionarRecompensaNivel(chaveVencedor, nivelAntesDuelo, statsVencedor.nivel) : 0;
                            const progVenc = garantirProgressoJogador(dadosGlobais, chaveVencedor);
                            progVenc.duelos += 1;
                            progVenc.vitoriasDuelos += 1;
                            const progPerd = garantirProgressoJogador(dadosGlobais, chavePerdedor);
                            progPerd.duelos += 1;
                            registrarMissao(dadosGlobais, chaveVencedor, 'duelos', 1);
                            aplicarXPPendenteDasMissoes(chaveVencedor);
                            adicionarPontosTemporadaSemValidacao(dadosGlobais, remoteJid, chaveVencedor, 10);
                            const conqDuelo = verificarConquistas(dadosGlobais, remoteJid, chaveVencedor);
                            await salvarDadosBot(dadosGlobais);

                            const chanceVencedor = vencedor === duelo.desafiante ? chanceA : (1 - chanceA);
                            return await sock.sendMessage(remoteJid, {
                                text: `⚔️ *DUELO FINALIZADO!*\n\n🏆 Vencedor: @${normalizarJid(vencedor)}\n📊 Níveis: *${nivelA}* × *${nivelB}*\n🎯 Chance estimada do vencedor: *${(chanceVencedor * 100).toFixed(1)}%*\n✨ XP ganho: *+50*` +
                                      (apostaDuelo > 0 ? `\n💰 Cada jogador apostou: *R$ ${apostaDuelo.toFixed(2)}*\n🏆 Vencedor recebeu: *R$ ${premioAposta.toFixed(2)}* (a própria aposta + a aposta do perdedor)\n💀 Perdedor perdeu: *R$ ${apostaDuelo.toFixed(2)}*` : '\n💰 Sem aposta') +
                                      (recompensaPerdedor > 0 ? `\n🎁 O perdedor recebeu uma pequena recompensa de *R$ ${recompensaPerdedor.toFixed(2)}*!` : '') +
                                      `\n💵 Saldo do vencedor: *R$ ${contaVencedor.dinheiro.toFixed(2)}*` +
                                      (recompensaNivelDuelo > 0 ? `\n🎊 Recompensa de nível: *R$ ${recompensaNivelDuelo.toFixed(2)}*` : '') +
                                      (conqDuelo.length ? `\n🏆 Novas conquistas: *${conqDuelo.length}*` : ''),
                                mentions: [vencedor, perdedor]
                            }, { quoted: m });
                        }

                        case 'log':
                            let statusBotLog = '🟢 Online e Ativo';
                            if (!dadosGlobais.botAtivo) {
                                statusBotLog = '🔴 Desligado';
                            } else if (dadosGlobais.modoTeste) {
                                statusBotLog = '🟡 Em Modo de Testes / Manutenção';
                                if (dadosGlobais.motivoModoTeste) {
                                    statusBotLog += `\n   └ 📌 *Aviso/Motivo:* ${dadosGlobais.motivoModoTeste}`;
                                }
                            }

                            const textoLogFormatado = `📜 *LOG E ESTADO DO BOT - ArleyBot*\n\n` +
                                                     `⚙️ *Estado Atual:* ${statusBotLog}\n\n` +
                                                     `📝 *Novidades da Versão:*\n${dadosGlobais.logTexto || 'Nenhum registo.'}`;

                            await sock.sendMessage(remoteJid, { text: textoLogFormatado }, { quoted: m });

                            if (souDono) {
                                limparEstadosPendentes(sender, remoteJid);
                                await enviarBotoesWhatsApp(remoteJid, `❓ *Dono detectado:*
Deseja alterar a mensagem das novidades do log?
_(Ou use .setlog <texto> para alterar direto)_`, [ { id: 'sim', text: '✏ Alterar texto' }, { id: 'nao', text: 'Cancelar' } ]);
                                aguardandoAcaoLog[stateKey] = 'confirmacao';
                                definirTimeoutLog(sender, remoteJid);
                            }
                            break;

                        case 'setlog':
                            if (!souDono) {
                                return await sock.sendMessage(remoteJid, { text: '❌ *Acesso Negado!* Comando exclusivo do dono.' }, { quoted: m });
                            }
                            if (!textArgs) {
                                return await sock.sendMessage(remoteJid, { text: `❌ Escreva o texto do log! Ex: *${prefix}setlog Nova versão com comandos diretos!*` }, { quoted: m });
                            }

                            dadosGlobais.logTexto = textArgs.trim();
                            await salvarDadosBot(dadosGlobais);
                            limparTimeoutLog(sender, remoteJid);
                            delete aguardandoAcaoLog[stateKey];

                            await sock.sendMessage(remoteJid, { text: '✅ Texto do log atualizado com sucesso sem confirmações!' }, { quoted: m });
                            break;

                        case 'settat':
                        case 'setteste':
                            if (!souDono) {
                                return await sock.sendMessage(remoteJid, { text: '❌ *Acesso Negado!* Comando exclusivo do dono.' }, { quoted: m });
                            }
                            if (!textArgs) {
                                return await sock.sendMessage(remoteJid, { text: `❌ Escreva a mensagem de aviso para o modo de testes! Ex: *${prefix}setteste Bot em manutenção rápida.*` }, { quoted: m });
                            }

                            dadosGlobais.motivoModoTeste = textArgs.trim();
                            await salvarDadosBot(dadosGlobais);
                            limparTimeoutTestar(sender, remoteJid);
                            delete aguardandoAcaoTestar[stateKey];

                            await sock.sendMessage(remoteJid, { text: `✅ Aviso do modo de testes atualizado diretamente para:\n\n💬 "${textArgs.trim()}"` }, { quoted: m });
                            break;

                        case 'acmd':
                            if (!isGroup) return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' });
                            
                            try {
                                const groupMetadataAcmd = await obterMetadadosGrupoComTimeout(remoteJid);
                                const isSenderAdminAcmd = await isAdminGrupo(remoteJid, cleanSender, souDono);

                                if (!isSenderAdminAcmd) {
                                    return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores do grupo podem usar este comando.' }, { quoted: m });
                                }

                                const statusSpam = gruposAntiSpamAtivo.has(remoteJid) ? '✅ Ativado' : '❌ Desativado';
                                const statusAviso = dadosGlobais.gruposAvisos?.[remoteJid] ? '✅ Ativado' : '❌ Desativado';
                                const statusBrincadeiras = dadosGlobais.brincadeiras?.[remoteJid] ? '✅ Ativado' : '❌ Desativado';
                                
                                let statusBot = '🟢 Online e Ativo';
                                if (!dadosGlobais.botAtivo) {
                                    statusBot = '🔴 Desligado';
                                } else if (dadosGlobais.modoTeste) {
                                    statusBot = '🟡 Em Testes / Manutenção';
                                    if (dadosGlobais.motivoModoTeste) {
                                        statusBot += `\n   └ 📌 *Aviso:* ${dadosGlobais.motivoModoTeste}`;
                                    }
                                }

                                let mutadosTexto = '';
                                let countMutados = 0;
                                const mentionedMutados = [];

                                for (const key in dadosGlobais.usuariosMutados) {
                                    if (key.startsWith(remoteJid)) {
                                        countMutados++;
                                        const userJid = key.split('_')[1];
                                        mentionedMutados.push(userJid);
                                        mutadosTexto += `\n- @${userJid.split('@')[0]}`;
                                    }
                                }
                                if (countMutados === 0) mutadosTexto = '\nNenhum membro mutado no momento.';

                                const acmdText = `📊 *PAINEL DO GRUPO (${groupMetadataAcmd.subject})* 📊\n\n` +
                                                 `🤖 *Estado do Bot:* ${statusBot}\n` +
                                                 `🛡️ *Anti-Spam:* ${statusSpam}\n` +
                                                 `📢 *Avisos:* ${statusAviso}\n` +
                                                 `🎉 *Brincadeiras/Economia:* ${statusBrincadeiras}\n\n` +
                                                 `🤐 *Membros Mutados (${countMutados}):* ${mutadosTexto}`;

                                await sock.sendMessage(remoteJid, { text: acmdText, mentions: mentionedMutados }, { quoted: m });
                            } catch (e) {
                                console.error("Erro no comando acmd:", e);
                                await sock.sendMessage(remoteJid, { text: '❌ Ocorreu um erro ao carregar os dados do grupo.' }, { quoted: m });
                            }
                            break;

                        case 'dono':
                        case 'centraldono':
                        case 'menuowner':
                        case 'menuadmin':
                            if (!souDono) {
                                return await sock.sendMessage(remoteJid, { text: '❌ *Acesso Negado!* Apenas o dono do bot pode aceder a este menu.' }, { quoted: m });
                            }
                            const menuDono = `
👑 *MENU DO DONO* 👑
┣━━━━━━━━━━━━━━━
┃ 🔸 *${prefix}testar* - Modo de manutenção interativo.
┃ 🔸 *${prefix}setlog <texto>* - Altera o log direto.
┃ 🔸 *${prefix}settat <texto>* - Altera o aviso de teste direto.
┃ 🔸 *${prefix}aviso* - Criar/editar aviso para os grupos.
┃ 🔸 *${prefix}reaviso* - Reenviar o último aviso salvo.
┃ 🔸 *${prefix}gp dinheiro* - Administrar saldo/XP/nível e cadastrar pessoas no Banco.
┃ 🔸 *${prefix}resetgp* - Resetar categorias individuais, uma pessoa ou o GP inteiro.
┃ 🔸 *${prefix}cadastrarbanco @pessoa* - Cadastra uma pessoa marcada no Banco.
┃ 🔸 *${prefix}centraldono* - Central administrativa
┃ 🔸 *${prefix}temporada* - Consultar temporada atual
┃ 🔸 *${prefix}statusjogador @pessoa* - Ver dados completos do jogador
┃ 🔸 *${prefix}ativarmsgale1 / 0* - Liga/Desliga mensagens aleatórias do grupo.
┃ 🔸 *${prefix}restart* - Reinicia o sistema do bot.
╰━━━━━━━━━━━━━━━`.trim();
                            await sock.sendMessage(remoteJid, { text: menuDono }, { quoted: m });
                            break;

                        case 'testar':
                            if (!souDono) {
                                return await sock.sendMessage(remoteJid, { text: '❌ *Acesso Negado!* Comando exclusivo do dono.' }, { quoted: m });
                            }

                            limparEstadosPendentes(sender, remoteJid);

                            if (dadosGlobais.modoTeste) {
                                aguardandoAcaoTestar[stateKey] = { etapa: 'perguntar_trocar_texto' };
                                definirTimeoutTestar(sender, remoteJid);
                                let msgAtual = dadosGlobais.motivoModoTeste ? `\n📌 *Aviso atual:* ${dadosGlobais.motivoModoTeste}` : '';
                                await enviarBotoesWhatsApp(remoteJid, `❓ *MODO TESTE ATIVO*${msgAtual}

Deseja alterar o texto/motivo da manutenção antes de desativar?`, [ { id: 'sim', text: '✏ Alterar texto' }, { id: 'nao', text: 'Continuar' } ], { quoted: m });
                            } else {
                                aguardandoAcaoTestar[stateKey] = { etapa: 'confirmar_ativar' };
                                definirTimeoutTestar(sender, remoteJid);
                                await enviarBotoesWhatsApp(remoteJid, `❓ *ATIVAR MODO TESTE*

Deseja ativar o modo de testes?`, [ { id: 'sim', text: '✅ Ativar' }, { id: 'nao', text: 'Cancelar' } ], { quoted: m });
                            }
                            break;

                        case 'avisoson':
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em *grupos*.' }, { quoted: m });
                            }
                            try {
                                const isAdminOn = await isAdminGrupo(remoteJid, cleanSender, souDono);

                                if (!isAdminOn) {
                                    return await sock.sendMessage(remoteJid, { text: '❌ Apenas *administradores* ou o *dono* podem ativar os avisos.' }, { quoted: m });
                                }

                                if (!dadosGlobais.gruposAvisos) dadosGlobais.gruposAvisos = {};
                                dadosGlobais.gruposAvisos[remoteJid] = true;
                                await salvarDadosBot(dadosGlobais);

                                await sock.sendMessage(remoteJid, { text: '📢 *Avisos ATIVADOS* neste grupo!\nEste grupo agora receberá os avisos de atualizações.' }, { quoted: m });
                            } catch (e) {
                                console.error(e);
                                await sock.sendMessage(remoteJid, { text: '❌ Erro ao ativar os avisos.' }, { quoted: m });
                            }
                            break;

                        case 'avisosoff':
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em *grupos*.' }, { quoted: m });
                            }
                            try {
                                const isAdminOff = await isAdminGrupo(remoteJid, cleanSender, souDono);

                                if (!isAdminOff) {
                                    return await sock.sendMessage(remoteJid, { text: '❌ Apenas *administradores* ou o *dono* podem desativar os avisos.' }, { quoted: m });
                                }

                                if (!dadosGlobais.gruposAvisos) dadosGlobais.gruposAvisos = {};
                                delete dadosGlobais.gruposAvisos[remoteJid];
                                await salvarDadosBot(dadosGlobais);

                                await sock.sendMessage(remoteJid, { text: '🔇 *Avisos DESATIVADOS* neste grupo.' }, { quoted: m });
                            } catch (e) {
                                console.error(e);
                                await sock.sendMessage(remoteJid, { text: '❌ Erro ao desativar os avisos.' }, { quoted: m });
                            }
                            break;

                        case 'aviso':
                            if (!souDono) {
                                return await sock.sendMessage(remoteJid, { text: '❌ *Acesso Negado!* Comando exclusivo do dono.' }, { quoted: m });
                            }

                            limparEstadosPendentes(sender, remoteJid);
                            limparTimeoutAviso(avisoStateKey);
                            delete aguardandoAcaoAviso[avisoStateKey];

                            let barraInicioAvisos = null;
                            try {
                                barraInicioAvisos = await criarBarraProgressoWhatsApp(remoteJid, m, 'Recebendo avisos', 'aviso');
                                await barraInicioAvisos.atualizar(20, 'Abrindo o sistema de avisos...', true);
                            } catch (erroInicioAvisos) {
                                console.warn('[AVISO] Não consegui mostrar o carregamento inicial:', erroInicioAvisos?.message || erroInicioAvisos);
                            }

                            if (dadosGlobais.textoAviso) {
                                aguardandoAcaoAviso[avisoStateKey] = { etapa: 'escolher_aviso_salvo' };
                                definirTimeoutAviso(avisoStateKey, remoteJid);
                                await barraInicioAvisos?.finalizar('Avisos carregados; escolha uma opção abaixo.').catch(() => {});
                                return await enviarOpcoesAvisoTexto(remoteJid, `📢 *SISTEMA DE AVISOS*

📌 *Texto salvo recentemente:*
"${dadosGlobais.textoAviso}"

❓ Deseja enviar o aviso salvo ou alterar o texto?`, [ { id: 'enviar', text: '📢 Enviar salvo' }, { id: 'alterar', text: '✏ Alterar texto' }, { id: 'cancelar', text: 'Cancelar' } ], { quoted: m });
                            } else {
                                aguardandoAcaoAviso[avisoStateKey] = { etapa: 'texto_aviso' };
                                definirTimeoutAviso(avisoStateKey, remoteJid);
                                const promptNovoAviso = '📢 *SISTEMA DE AVISOS*\n\n📌 Nenhum texto de aviso salvo ainda.\n\n✏️ Mande agora o *texto do aviso* (você tem 30 segundos):';
                                const promptSubstituido = await barraInicioAvisos?.substituir({ text: promptNovoAviso }).catch(() => null);
                                if (promptSubstituido) return promptSubstituido;
                                return await enviarEIgnorar(remoteJid, { text: promptNovoAviso }, { quoted: m });
                            }

                        case 'reaviso':
                            if (!souDono) {
                                return await sock.sendMessage(remoteJid, { text: '❌ *Acesso Negado!* Comando exclusivo do dono.' }, { quoted: m });
                            }

                            limparEstadosPendentes(sender, remoteJid);
                            limparTimeoutAviso(avisoStateKey);
                            delete aguardandoAcaoAviso[avisoStateKey];

                            if (!dadosGlobais.textoAviso) {
                                return await sock.sendMessage(remoteJid, { text: '❌ *Nenhum aviso salvo na memória!* Use `.aviso` primeiro para cadastrar um texto de aviso.' }, { quoted: m });
                            }

                            const gruposReaviso = await listarGruposComAvisos();
                            
                            if (gruposReaviso.length === 0) {
                                return await sock.sendMessage(remoteJid, { 
                                    text: '⚠️ O aviso salvo está pronto, mas *nenhum grupo* está com avisos ativados no momento.\nUse `.avisoson` nos grupos desejados.' 
                                }, { quoted: m });
                            }

                            let listaNomesReaviso = gruposReaviso.map((g) => `• ${g.nome}`).join('\n');
                            aguardandoAcaoAviso[avisoStateKey] = { etapa: 'confirmar_enviar', grupos: gruposReaviso };
                            definirTimeoutAviso(avisoStateKey, remoteJid);

                            return await enviarOpcoesAvisoTexto(remoteJid, `📢 *REAVISO - DISPARO DE AVISO SALVO*

📌 *Aviso que será enviado:*
"${dadosGlobais.textoAviso}"

👥 *Grupos destino (${gruposReaviso.length}):*
${listaNomesReaviso}

❓ Deseja reenviar este aviso agora para esses grupos?`, [ { id: 'sim', text: '🚀 Reenviar' }, { id: 'nao', text: 'Cancelar' } ], { quoted: m });
                            break;

                        case 'gp':
                        case 'gpdinheiro':
                            if (!souDono) {
                                return await sock.sendMessage(remoteJid, { text: '❌ *Acesso Negado!* Este comando é exclusivo do dono do bot.' }, { quoted: m });
                            }

                            if (command === 'gp' && String(args[0] || '').toLowerCase() !== 'dinheiro') {
                                return await sock.sendMessage(remoteJid, { text: `❌ Use *${prefix}gp dinheiro* para administrar o dinheiro dos grupos.` }, { quoted: m });
                            }

                            limparEstadosPendentes(sender, remoteJid);
                            const gruposBrincadeiras = await listarGruposBrincadeiras();

                            if (gruposBrincadeiras.length === 0) {
                                return await sock.sendMessage(remoteJid, {
                                    text: '❌ Nenhum grupo está com o *modo brincadeira* ativado no momento.'
                                }, { quoted: m });
                            }

                            const listaGruposGP = gruposBrincadeiras.map((g, i) => `${i + 1}. ${g.nome}`).join('\n');
                            aguardandoGPDinheiro[stateKey] = {
                                remoteJid,
                                etapa: 'escolher_grupo',
                                grupos: gruposBrincadeiras
                            };
                            definirTimeoutGPDinheiro(sender, remoteJid);

                            return await enviarEIgnorar(remoteJid, {
                                text: `👑 *GP DINHEIRO — DONO*\n\n` +
                                      `Selecione o grupo que deseja administrar: 
\n${listaGruposGP}\n\n` +
                                      `Digite o *número* do grupo.`,
                            }, { quoted: m });

                        case 'resetgp':
                        case 'resetgpdinheiro': {
                            if (!souDono) {
                                return await sock.sendMessage(remoteJid, { text: '❌ *Acesso Negado!* Este comando é exclusivo do dono do bot.' }, { quoted: m });
                            }

                            limparEstadosPendentes(sender, remoteJid);
                            const gruposResetGP = await listarGruposBrincadeiras();

                            if (gruposResetGP.length === 0) {
                                return await sock.sendMessage(remoteJid, {
                                    text: '❌ Nenhum grupo está com o *modo brincadeira* ativado no momento.'
                                }, { quoted: m });
                            }

                            const listaGruposReset = gruposResetGP.map((g, i) => `${i + 1}. ${g.nome}`).join('\n');
                            aguardandoResetGP[stateKey] = {
                                remoteJid,
                                etapa: 'escolher_grupo',
                                grupos: gruposResetGP
                            };
                            definirTimeoutResetGP(sender, remoteJid);

                            return await enviarEIgnorar(remoteJid, {
                                text: `♻️ *RESET GP — DONO*\n\n` +
                                      `Selecione o grupo onde deseja resetar os perfis:\n\n${listaGruposReset}\n\n` +
                                      `Digite o *número* do grupo.`,
                            }, { quoted: m });
                        }

                        case 'restart': {
                            if (!souDono && (!isGroup || !(await isAdminGrupo(remoteJid, cleanSender, souDono)))) {
                                return await sock.sendMessage(remoteJid, {
                                    text: '❌ Para reiniciar o bot, use este comando como dono ou administrador do grupo.'
                                }, { quoted: m });
                            }
                            const motivoRestart = souDono ? 'comando do dono' : 'comando de administrador do grupo';
                            try {
                                await writeFile(ARQUIVO_AVISO_RESTART, JSON.stringify({
                                    remoteJid,
                                    motivo: motivoRestart,
                                    criadoEm: Date.now()
                                }, null, 2), 'utf8');
                            } catch (erroSalvarAvisoRestart) {
                                console.error('[RESTART] Não consegui salvar o aviso de retorno:', erroSalvarAvisoRestart?.message || erroSalvarAvisoRestart);
                            }
                            // O comando já foi registrado na linha [COMANDO].
                            await sock.sendMessage(remoteJid, {
                                text: '🔄 *REINICIANDO O ARLEYBOT...*\n\nVou reiniciar agora para tentar corrigir a falha. Assim que voltar, enviarei um aviso aqui.'
                            }, { quoted: m });
                            await delay(800);
                            process.exit(1);
                            break;
                        }

                        case 'unmuteall':
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            }
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem desmutar todos.' }, { quoted: m });
                            }
                            let contadorDesmutados = 0;
                            for (let chave in dadosGlobais.usuariosMutados) {
                                if (chave.startsWith(`${remoteJid}_`)) {
                                    delete dadosGlobais.usuariosMutados[chave];
                                    contadorDesmutados++;
                                }
                            }
                            
                            if (contadorDesmutados > 0) {
                                await salvarDadosBot(dadosGlobais);
                                await sock.sendMessage(remoteJid, { text: `✅ *Sucesso!* Todos os ${contadorDesmutados} utilizadores mutados foram desmutados.` }, { quoted: m });
                            } else {
                                await sock.sendMessage(remoteJid, { text: `⚠ Ninguém está mutado neste grupo atualmente.` }, { quoted: m });
                            }
                            break;

                        case 'desligar':
                            if (!souDono) return;
                            dadosGlobais.botAtivo = false;
                            await salvarDadosBot(dadosGlobais);
                            await sock.sendMessage(remoteJid, { text: '🔴 *ArleyBot desligado!* Estado salvo no ficheiro e inativo.' }, { quoted: m });
                            break;

                        case 'ligar':
                            dadosGlobais.botAtivo = true;
                            await salvarDadosBot(dadosGlobais);
                            await sock.sendMessage(remoteJid, { text: '🟢 O bot já está ligado!' }, { quoted: m });
                            break;

                        case 'd':
                        case 'apagar':
                            try {
                                if (isGroup) {
                                    const isAdminD = await isAdminGrupo(remoteJid, cleanSender, souDono);

                                    if (!isAdminD) {
                                        return await sock.sendMessage(remoteJid, { text: '❌ *Acesso Negado!* Apenas administradores do grupo podem apagar mensagens.' }, { quoted: m });
                                    }
                                }

                                const contextInfo = corpoMsg.extendedTextMessage?.contextInfo;
                                if (!contextInfo || !contextInfo.stanzaId) {
                                    return await sock.sendMessage(remoteJid, { text: `❌ Responda à mensagem que deseja apagar com *${prefix}d*` }, { quoted: m });
                                }

                                const messageId = contextInfo.stanzaId;
                                const participant = contextInfo.participant;
                                
                                const botNumber = getBotJid();
                                const isBotMessage = participant === botNumber || contextInfo.fromMe;

                                const key = {
                                    remoteJid: remoteJid,
                                    id: messageId,
                                    fromMe: isBotMessage,
                                    participant: participant
                                };

                                await sock.sendMessage(remoteJid, { delete: key });

                                try {
                                    await sock.sendMessage(remoteJid, { delete: m.key });
                                } catch (e) {}

                            } catch (erro) {
                                console.error('Erro ao apagar mensagem:', erro);
                                await sock.sendMessage(remoteJid, { text: '❌ Não foi possível apagar a mensagem. Certifique-se de que o bot é administrador.' }, { quoted: m });
                            }
                            break;

                        case 'fixar':
                        case 'pin':
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            }
                            try {
                                const isAdminFixar = await isAdminGrupo(remoteJid, cleanSender, souDono);

                                if (!isAdminFixar) {
                                    return await sock.sendMessage(remoteJid, { text: '❌ *Acesso Negado!* Apenas administradores do grupo podem fixar mensagens.' }, { quoted: m });
                                }

                                const contextInfo = corpoMsg.extendedTextMessage?.contextInfo;
                                if (!contextInfo || !contextInfo.stanzaId) {
                                    return await sock.sendMessage(remoteJid, { text: `❌ Responda à mensagem que deseja fixar com *${prefix}fixar*` }, { quoted: m });
                                }

                                const messageId = contextInfo.stanzaId;
                                const participant = contextInfo.participant || remoteJid;
                                const botJid = getBotJid();
                                const isBotMessage = normalizarJid(participant) === normalizarJid(botJid);

                                const key = {
                                    remoteJid: remoteJid,
                                    id: messageId,
                                    fromMe: isBotMessage,
                                    participant: participant
                                };

                                await sock.relayMessage(remoteJid, {
                                    pinInChatMessage: {
                                        key: key,
                                        type: 1, 
                                        time: 604800 
                                    }
                                }, {});

                                await sock.sendMessage(remoteJid, { text: '📌 Mensagem fixada com sucesso!' }, { quoted: m });
                            } catch (erro) {
                                console.error('Erro ao fixar mensagem:', erro);
                                await sock.sendMessage(remoteJid, { text: '❌ Não foi possível fixar a mensagem. Certifique-se de que o bot é administrador do grupo.' }, { quoted: m });
                            }
                            break;

                        case 'totag':
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            }
                            try {
                                const participantesTotag = await obterParticipantes(remoteJid);
                                const mentionsTotag = [...new Set(participantesTotag
                                    .map(p => p?.id || p?.jid || p?.phoneNumber)
                                    .filter(jid => typeof jid === 'string' && jid.includes('@')))];

                                const contextoTotag = corpoMsg.extendedTextMessage?.contextInfo;
                                const quotedTotag = contextoTotag?.quotedMessage || null;
                                const quotedText = obterTextoMensagem(quotedTotag).trim();
                                const mediaInfo = quotedTotag ? getMediaMessage(quotedTotag) : null;
                                // Prioriza sempre a mensagem respondida. Se não houve resposta,
                                // permite usar .totag <texto> como atalho para repetir o texto.
                                const textoOriginal = String(quotedTotag ? quotedText : (textArgs || '')).trim();

                                if (!mediaInfo && !textoOriginal) {
                                    return await sock.sendMessage(remoteJid, {
                                        text: `ℹ️ Responda à mensagem que deseja repetir com *${prefix}totag*. Também pode usar *${prefix}totag <texto>*.\n\nA mensagem será repetida sem lista de participantes; a marcação de todos fica invisível.`
                                    }, { quoted: m });
                                }

                                // Envia a mensagem original e injeta as menções apenas nos metadados
                                // do protocolo. Não escreve @números nem adiciona cabeçalhos visíveis.
                                if (mediaInfo) {
                                    const stream = await downloadContentFromMessage(mediaInfo.msg, mediaInfo.type);
                                    const buffer = await streamParaBufferLimitado(stream, LIMITE_BUFFER_MIDIA_BYTES, 'mídia do totag');
                                    let conteudoMidia;
                                    let tipoMensagem;

                                    if (mediaInfo.type === 'image') {
                                        conteudoMidia = {
                                            image: buffer,
                                            ...(quotedText ? { caption: quotedText } : {}),
                                            mimetype: mediaInfo.msg.mimetype || 'image/jpeg'
                                        };
                                        tipoMensagem = 'imageMessage';
                                    } else if (mediaInfo.type === 'video') {
                                        conteudoMidia = {
                                            video: buffer,
                                            ...(quotedText ? { caption: quotedText } : {}),
                                            mimetype: mediaInfo.msg.mimetype || 'video/mp4',
                                            ...(mediaInfo.msg.gifPlayback ? { gifPlayback: true } : {})
                                        };
                                        tipoMensagem = 'videoMessage';
                                    } else if (mediaInfo.type === 'sticker') {
                                        conteudoMidia = { sticker: buffer, mimetype: mediaInfo.msg.mimetype || 'image/webp' };
                                        tipoMensagem = 'stickerMessage';
                                    } else if (mediaInfo.type === 'audio') {
                                        conteudoMidia = {
                                            audio: buffer,
                                            mimetype: mediaInfo.msg.mimetype || 'audio/mpeg',
                                            ptt: !!mediaInfo.msg.ptt
                                        };
                                        tipoMensagem = 'audioMessage';
                                    } else if (mediaInfo.type === 'document') {
                                        conteudoMidia = {
                                            document: buffer,
                                            mimetype: mediaInfo.msg.mimetype || 'application/octet-stream',
                                            fileName: mediaInfo.msg.fileName || 'arquivo',
                                            ...(quotedText ? { caption: quotedText } : {})
                                        };
                                        tipoMensagem = 'documentMessage';
                                    } else {
                                        throw new Error(`Tipo de mídia não suportado pelo totag: ${mediaInfo.type}`);
                                    }

                                    const preparadaTotag = await prepareWAMessageMedia(conteudoMidia, {
                                        upload: sock.waUploadToServer
                                    });
                                    const corpoMidiaPreparado = preparadaTotag?.[tipoMensagem];
                                    if (!corpoMidiaPreparado) {
                                        throw new Error(`Não foi possível preparar ${tipoMensagem} para o totag`);
                                    }
                                    corpoMidiaPreparado.contextInfo = {
                                        ...(corpoMidiaPreparado.contextInfo || {}),
                                        ...(mentionsTotag.length ? { mentionedJid: mentionsTotag } : {})
                                    };

                                    const conteudoProtocolo = proto.Message.fromObject({
                                        [tipoMensagem]: corpoMidiaPreparado
                                    });
                                    const mensagemTotag = generateWAMessageFromContent(remoteJid, conteudoProtocolo, {
                                        userJid: sock.user?.id
                                    });
                                    await sock.relayMessage(remoteJid, mensagemTotag.message, {
                                        messageId: mensagemTotag.key.id
                                    });
                                    marcarMensagemIgnorar(mensagemTotag.key.id, 60000);
                                } else {
                                    const enviadaTotag = await sock.sendMessage(remoteJid, {
                                        text: textoOriginal,
                                        // A documentação do Baileys permite omitir @número no texto;
                                        // a lista de JIDs mantém as menções fora do conteúdo visível.
                                        mentions: mentionsTotag
                                    });
                                    if (enviadaTotag?.key?.id) marcarMensagemIgnorar(enviadaTotag.key.id, 60000);
                                }
                            } catch (erro) {
                                console.error('Erro no totag:', erro);
                                await sock.sendMessage(remoteJid, { text: '❌ Não consegui repetir essa mensagem com a marcação invisível. Tente novamente ou envie o tipo de mídia em outro formato.' }, { quoted: m });
                            }
                            break;

                        case 'marcar-todos':
                        case 'tagall':
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            }
                            try {
                                const participantesTag = await obterParticipantes(remoteJid);
                                let textoTag = `📢 *CHAMANDO TODOS* (${participantesTag.length} participantes)\n\n`;
                                
                                if (textArgs) {
                                    textoTag += `💬 *Mensagem:* ${textArgs}\n\n`;
                                }
                                
                                for (let p of participantesTag) {
                                    textoTag += `╠ @${p.id.split('@')[0]}\n`;
                                }
                                textoTag += `╚════════════════`;

                                const mentionsAll = participantesTag.map(p => p.id);
                                await sock.sendMessage(remoteJid, { text: textoTag, mentions: mentionsAll });
                            } catch (erro) {
                                console.error('Erro no marcar-todos:', erro);
                                await sock.sendMessage(remoteJid, { text: '❌ Ocorreu um erro ao marcar os participantes.' }, { quoted: m });
                            }
                            break;

                        case 'toimg': {
                            let progressoToimg = null;
                            try {
                                const quoted = corpoMsg.extendedTextMessage?.contextInfo?.quotedMessage;
                                const mediaInfo = getMediaMessage(quoted);

                                if (!mediaInfo || !['sticker', 'image', 'video'].includes(mediaInfo.type)) {
                                    return await sock.sendMessage(remoteJid, { text: `❌ Responda a uma figurinha ou a uma foto/vídeo de visualização única com *${prefix}toimg*` }, { quoted: m });
                                }

                                const titulo = mediaInfo.type === 'sticker'
                                    ? 'Convertendo figurinha em imagem'
                                    : 'Revelando mídia como imagem';
                                progressoToimg = await criarBarraProgressoWhatsApp(remoteJid, m, titulo, 'imagem');
                                await progressoToimg.atualizar(10, 'Preparando o download...');

                                if (mediaInfo.type === 'sticker') {
                                    const stream = await downloadContentFromMessage(mediaInfo.msg, 'sticker');
                                    const buffer = await streamParaBufferLimitado(stream, 16 * 1024 * 1024, 'figurinha');
                                    if (!buffer.length) throw new Error('A figurinha recebida está vazia.');
                                    await progressoToimg.atualizar(48, 'Figurinha baixada; convertendo para PNG...');

                                    const base = `toimg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                                    const tempInput = path.join(PASTA_TEMP, `${base}.webp`);
                                    const tempPreparado = path.join(PASTA_TEMP, `${base}_limpo.webp`);
                                    const tempOutput = path.join(PASTA_TEMP, `${base}.png`);
                                    try {
                                        // Algumas figurinhas WebP têm metadados/chunks que certos FFmpeg
                                        // do Android não conseguem ler. Tentamos o original e o WebP preparado.
                                        await writeFile(tempInput, buffer);
                                        const bufferPreparado = prepararWebPParaFFmpeg(buffer);
                                        await writeFile(tempPreparado, bufferPreparado);
                                        let erroConversao = null;
                                        const tentativas = [
                                            ['ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', tempInput, '-frames:v', '1', tempOutput]],
                                            ['ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', tempPreparado, '-frames:v', '1', tempOutput]],
                                            ['magick', [`${tempPreparado}[0]`, tempOutput]],
                                            ['convert', [`${tempPreparado}[0]`, tempOutput]]
                                        ];
                                        for (const [comando, args] of tentativas) {
                                            try {
                                                if (existsSync(tempOutput)) await unlink(tempOutput).catch(() => {});
                                                await executarProcesso(comando, args, { timeoutMs: 60000, maxBuffer: 2 * 1024 * 1024 });
                                                const teste = await readFile(tempOutput);
                                                if (teste.length > 0) { erroConversao = null; break; }
                                                throw new Error(`${comando} não gerou imagem`);
                                            } catch (e) {
                                                erroConversao = e;
                                                console.warn(`⚠️ ${comando} não conseguiu converter a figurinha:`, e?.message || e);
                                            }
                                        }
                                        if (erroConversao) {
                                            throw new Error('Não consegui ler esta figurinha WebP. Atualize o FFmpeg ou instale ImageMagick (pkg install imagemagick). Detalhe: ' + (erroConversao?.message || 'falha na conversão'));
                                        }
                                        const imgBuffer = await readFile(tempOutput);
                                        if (!imgBuffer.length) throw new Error('O conversor gerou uma imagem vazia.');
                                        await progressoToimg.atualizar(92, 'Imagem pronta; enviando...');
                                        await sock.sendMessage(remoteJid, { image: imgBuffer, caption: '✅ Figurinha convertida em imagem com sucesso!' }, { quoted: m });
                                        await progressoToimg.finalizar('Imagem enviada!');
                                    } finally {
                                        if (existsSync(tempInput)) await unlink(tempInput).catch(() => {});
                                        if (existsSync(tempPreparado)) await unlink(tempPreparado).catch(() => {});
                                        if (existsSync(tempOutput)) await unlink(tempOutput).catch(() => {});
                                    }
                                } else if (mediaInfo.type === 'image') {
                                    const stream = await downloadContentFromMessage(mediaInfo.msg, 'image');
                                    const buffer = await streamParaBufferLimitado(stream, LIMITE_BUFFER_MIDIA_BYTES, 'imagem');
                                    if (!buffer.length) throw new Error('A foto recebida está vazia.');
                                    await progressoToimg.atualizar(92, 'Foto recebida; enviando...');
                                    const legendaComMidia = mediaInfo.msg.caption || '🔓 Foto de visualização única revelada!';
                                    await sock.sendMessage(remoteJid, { image: buffer, caption: legendaComMidia }, { quoted: m });
                                    await progressoToimg.finalizar('Imagem enviada!');
                                } else if (mediaInfo.type === 'video') {
                                    const stream = await downloadContentFromMessage(mediaInfo.msg, 'video');
                                    const buffer = await streamParaBufferLimitado(stream, LIMITE_BUFFER_MIDIA_BYTES, 'vídeo');
                                    if (!buffer.length) throw new Error('O vídeo recebido está vazio.');
                                    await progressoToimg.atualizar(92, 'Vídeo recebido; enviando...');
                                    const legendaComMidia = mediaInfo.msg.caption || '🔓 Vídeo de visualização único revelado!';
                                    await sock.sendMessage(remoteJid, { video: buffer, caption: legendaComMidia }, { quoted: m });
                                    await progressoToimg.finalizar('Vídeo enviado!');
                                }
                            } catch (erro) {
                                console.error('Erro no toimg:', erro);
                                if (progressoToimg) {
                                    await progressoToimg.falhar(`Não consegui concluir: ${(erro?.message || 'erro desconhecido').slice(0, 140)}`);
                                } else {
                                    await sock.sendMessage(remoteJid, { text: `❌ Ocorreu um erro ao converter a mídia.\n📌 ${erro?.message || 'Erro desconhecido.'}` }, { quoted: m }).catch(() => {});
                                }
                            }
                            break;
                        }

                        case 'tovideo': {
                            let progressoTovideo = null;
                            try {
                                const quoted = corpoMsg.extendedTextMessage?.contextInfo?.quotedMessage;
                                const mediaInfo = getMediaMessage(quoted);

                                if (!mediaInfo || !['sticker', 'video'].includes(mediaInfo.type)) {
                                    return await sock.sendMessage(remoteJid, { text: `❌ Responda a uma figurinha ou a um vídeo de visualização única com *${prefix}tovideo*` }, { quoted: m });
                                }

                                if (mediaInfo.type === 'video') {
                                    progressoTovideo = await criarBarraProgressoWhatsApp(remoteJid, m, 'Revelando vídeo', 'video');
                                    await progressoTovideo.atualizar(15, 'Baixando vídeo...');
                                    const stream = await downloadContentFromMessage(mediaInfo.msg, 'video');
                                    const buffer = await streamParaBufferLimitado(stream, LIMITE_BUFFER_MIDIA_BYTES, 'vídeo');
                                    if (!buffer.length) throw new Error('O vídeo recebido está vazio.');
                                    await progressoTovideo.atualizar(92, 'Vídeo recebido; enviando...');
                                    const legenda = mediaInfo.msg.caption || '🔓 Vídeo de visualização único revelado!';
                                    await sock.sendMessage(remoteJid, { video: buffer, caption: legenda }, { quoted: m });
                                    await progressoTovideo.finalizar('Vídeo enviado!');
                                } else if (mediaInfo.type === 'sticker') {
                                    progressoTovideo = await criarBarraProgressoWhatsApp(remoteJid, m, 'Convertendo figurinha em vídeo', 'conversao');
                                    await progressoTovideo.atualizar(12, 'Baixando figurinha...');

                                    const stream = await downloadContentFromMessage(mediaInfo.msg, 'sticker');
                                    const bufferOriginal = await streamParaBufferLimitado(stream, 16 * 1024 * 1024, 'figurinha');
                                    if (!bufferOriginal.length) throw new Error('A figurinha recebida está vazia.');
                                    await progressoTovideo.atualizar(30, 'Validando animação...');

                                    const infoOriginal = analisarWebP(bufferOriginal);
                                    if (!infoOriginal.valido) throw new Error('A figurinha recebida não é um WebP válido.');
                                    const bufferFFmpeg = prepararWebPParaFFmpeg(bufferOriginal);
                                    const infoFFmpeg = analisarWebP(bufferFFmpeg);
                                    if (!infoFFmpeg.valido) throw new Error('Não foi possível preparar o WebP para o FFmpeg.');

                                    const ehWebpAnimado = Boolean(infoFFmpeg.animado && infoFFmpeg.quadros >= 2);
                                    const base = `tovideo_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                                    const tempInput = path.join(PASTA_TEMP, `${base}.webp`);
                                    const tempOutput = path.join(PASTA_TEMP, `${base}.mp4`);
                                    try {
                                        await writeFile(tempInput, bufferFFmpeg);
                                        await progressoTovideo.atualizar(44, 'Convertendo para MP4...');

                                        // Algumas versões do FFmpeg não reconhecem a opção de loop
                                        // do WebP animado. Tentamos primeiro o modo próprio do demuxer
                                        // e depois a abertura automática, validando que os quadros foram
                                        // preservados para não enviar um vídeo congelado.
                                        const variantesEntrada = ehWebpAnimado
                                            ? [
                                                { nome: 'WebP animado (reprodução única)', args: ['-ignore_loop', '1', '-i', tempInput] },
                                                { nome: 'WebP animado (compatibilidade)', args: ['-i', tempInput] }
                                            ]
                                            : [
                                                { nome: 'WebP estático em loop', args: ['-stream_loop', '-1', '-i', tempInput] }
                                            ];
                                        const variantesCodec = [
                                            { nome: 'H.264', args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23'] },
                                            { nome: 'MPEG-4 compatível', args: ['-c:v', 'mpeg4', '-q:v', '5'] }
                                        ];
                                        const errosTentativas = [];
                                        let videoBuffer = null;

                                        for (const entrada of variantesEntrada) {
                                            for (const codec of variantesCodec) {
                                                if (existsSync(tempOutput)) await unlink(tempOutput).catch(() => {});
                                                try {
                                                    const ffmpegArgs = [
                                                        '-y', '-hide_banner', '-loglevel', 'error',
                                                        ...entrada.args,
                                                        '-map', '0:v:0',
                                                        '-t', String(ehWebpAnimado ? LIMITE_FIGURINHA_VIDEO_SEGUNDOS : 3),
                                                        '-vf', 'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2,setsar=1',
                                                        '-an', ...codec.args,
                                                        '-pix_fmt', 'yuv420p',
                                                        '-movflags', '+faststart',
                                                        '-map_metadata', '-1',
                                                        tempOutput
                                                    ];
                                                    await executarProcesso('ffmpeg', ffmpegArgs, {
                                                        timeoutMs: 120000,
                                                        maxBuffer: 4 * 1024 * 1024
                                                    });

                                                    if (!existsSync(tempOutput)) {
                                                        throw new Error('O FFmpeg terminou sem criar o vídeo.');
                                                    }
                                                    const candidato = await readFile(tempOutput);
                                                    if (!candidato.length) throw new Error('O vídeo convertido ficou vazio.');

                                                    if (ehWebpAnimado) {
                                                        // Garante que uma figurinha animada não vire só uma imagem parada.
                                                        const probe = await executarProcesso('ffprobe', [
                                                            '-v', 'error',
                                                            '-select_streams', 'v:0',
                                                            '-count_frames',
                                                            '-show_entries', 'stream=nb_read_frames',
                                                            '-of', 'json',
                                                            tempOutput
                                                        ], { timeoutMs: 20000, maxBuffer: 1024 * 1024 });
                                                        const jsonProbe = JSON.parse(probe.stdout || '{}');
                                                        const quadrosVideo = Number(jsonProbe?.streams?.[0]?.nb_read_frames);
                                                        if (!Number.isFinite(quadrosVideo) || quadrosVideo < 2) {
                                                            throw new Error('O FFmpeg leu a figurinha, mas não conseguiu preservar os quadros da animação.');
                                                        }
                                                    }

                                                    videoBuffer = candidato;
                                                    // Conversão validada; o usuário recebe o resultado no WhatsApp.
                                                    break;
                                                } catch (erroTentativa) {
                                                    const detalheTentativa = String(erroTentativa?.message || erroTentativa || 'erro desconhecido');
                                                    errosTentativas.push(`${entrada.nome}/${codec.nome}: ${detalheTentativa}`);
                                                    // Uma tentativa falhou; a próxima alternativa será testada.
                                                }
                                            }
                                            if (videoBuffer) break;
                                        }

                                        // Rota alternativa: algumas builds do FFmpeg do Android não incluem
                                        // o demuxer de WebP animado. O ImageMagick recompõe os quadros
                                        // antes de o FFmpeg codificar o MP4. Requer `pkg install imagemagick`.
                                        const tempGif = path.join(PASTA_TEMP, `${base}_quadros.gif`);
                                        if (!videoBuffer && ehWebpAnimado) {
                                            try {
                                                await progressoTovideo.atualizar(68, 'Recuperando quadros da animação...');
                                                if (existsSync(tempGif)) await unlink(tempGif).catch(() => {});
                                                await executarImageMagick([
                                                    tempInput, '-coalesce', '-strip', '-loop', '1', tempGif
                                                ], { timeoutMs: 120000, maxBuffer: 4 * 1024 * 1024 });
                                                const gifRecuperado = await readFile(tempGif);
                                                if (!gifRecuperado.length) throw new Error('O ImageMagick criou um GIF vazio.');

                                                for (const codec of variantesCodec) {
                                                    if (existsSync(tempOutput)) await unlink(tempOutput).catch(() => {});
                                                    try {
                                                        await progressoTovideo.atualizar(78, `Montando MP4 (${codec.nome})...`);
                                                        const argsGif = [
                                                            '-y', '-hide_banner', '-loglevel', 'error',
                                                            '-i', tempGif,
                                                            '-map', '0:v:0', '-t', String(LIMITE_FIGURINHA_VIDEO_SEGUNDOS),
                                                            '-vf', 'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2,setsar=1',
                                                            '-an', ...codec.args,
                                                            '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                                                            '-map_metadata', '-1', tempOutput
                                                        ];
                                                        await executarProcesso('ffmpeg', argsGif, {
                                                            timeoutMs: 120000,
                                                            maxBuffer: 4 * 1024 * 1024
                                                        });
                                                        const probe = await executarProcesso('ffprobe', [
                                                            '-v', 'error', '-select_streams', 'v:0', '-count_frames',
                                                            '-show_entries', 'stream=nb_read_frames', '-of', 'json', tempOutput
                                                        ], { timeoutMs: 20000, maxBuffer: 1024 * 1024 });
                                                        const jsonProbe = JSON.parse(probe.stdout || '{}');
                                                        const quadrosVideo = Number(jsonProbe?.streams?.[0]?.nb_read_frames);
                                                        if (!Number.isFinite(quadrosVideo) || quadrosVideo < 2) {
                                                            throw new Error('A rota alternativa não conseguiu preservar os quadros animados.');
                                                        }
                                                        videoBuffer = await readFile(tempOutput);
                                                        if (!videoBuffer.length) throw new Error('O MP4 alternativo ficou vazio.');
                                                        // Conversão alternativa validada; sem log repetitivo.
                                                        break;
                                                    } catch (erroGifCodec) {
                                                        const detalhe = String(erroGifCodec?.message || erroGifCodec || 'erro desconhecido');
                                                        errosTentativas.push(`ImageMagick/GIF/${codec.nome}: ${detalhe}`);
                                                        // Continua tentando o próximo codec, sem spam no terminal.
                                                    }
                                                }
                                            } catch (erroImagemMagick) {
                                                const detalhe = String(erroImagemMagick?.message || erroImagemMagick || 'erro desconhecido');
                                                errosTentativas.push(`ImageMagick: ${detalhe}`);
                                                // O erro será retornado ao comando caso todas as alternativas falhem.
                                            }
                                        }

                                        if (!videoBuffer) {
                                            const detalhes = errosTentativas.join('\n').slice(-900);
                                            if (/spawn magick.*enoent|magick.*command not found|no such file or directory.*magick/i.test(detalhes)) {
                                                throw new Error(`O FFmpeg deste Termux não conseguiu abrir a figurinha animada e o ImageMagick não está instalado. Execute: pkg update && pkg upgrade ffmpeg -y && pkg install imagemagick -y. Detalhes: ${detalhes.slice(-400)}`);
                                            }
                                            if (/ignore_loop|unrecognized option|option .* not found|unknown input format|animated webp|preservar os quadros|preservar a animação|image data not found|invalid data found when processing input/i.test(detalhes)) {
                                                throw new Error(`Este FFmpeg não conseguiu ler todos os quadros do WebP animado. Atualize e instale o suporte alternativo no Termux com: pkg update && pkg upgrade ffmpeg -y && pkg install imagemagick -y. Detalhes: ${detalhes.slice(-500)}`);
                                            }
                                            if (/spawn ffprobe.*enoent|ffprobe.*command not found|no such file or directory.*ffprobe/i.test(detalhes)) {
                                                throw new Error(`O ffprobe não foi encontrado. Reinstale o FFmpeg no Termux com: pkg reinstall ffmpeg -y. Detalhes: ${detalhes.slice(-400)}`);
                                            }
                                            if (/unknown encoder.*libx264|encoder .* not found/i.test(detalhes)) {
                                                throw new Error(`O FFmpeg não encontrou um encoder de vídeo compatível. Atualize/reinstale com: pkg reinstall ffmpeg -y. Detalhes: ${detalhes.slice(-500)}`);
                                            }
                                            throw new Error(`Todas as tentativas de conversão falharam. ${detalhes || 'O FFmpeg não retornou detalhes.'}`);
                                        }

                                        await progressoTovideo.atualizar(93, 'Vídeo pronto; enviando...');
                                        await sock.sendMessage(remoteJid, {
                                            video: videoBuffer,
                                            mimetype: 'video/mp4',
                                            caption: ehWebpAnimado
                                                ? '✅ Figurinha animada convertida para vídeo com sucesso!'
                                                : '✅ Figurinha convertida para vídeo com sucesso!'
                                        }, { quoted: m });
                                        await progressoTovideo.finalizar('Vídeo enviado!');
                                    } finally {
                                        if (existsSync(tempInput)) await unlink(tempInput).catch(() => {});
                                        if (existsSync(tempOutput)) await unlink(tempOutput).catch(() => {});
                                        const tempGifLimpeza = path.join(PASTA_TEMP, `${base}_quadros.gif`);
                                        if (existsSync(tempGifLimpeza)) await unlink(tempGifLimpeza).catch(() => {});
                                    }
                                }
                            } catch (erro) {
                                console.error('Erro no tovideo:', erro);
                                if (progressoTovideo) {
                                    await progressoTovideo.falhar(`Não consegui converter: ${(erro?.message || 'erro desconhecido').slice(0, 240)}`);
                                } else {
                                    await sock.sendMessage(remoteJid, { text: `❌ Não consegui converter a mídia.\n\n📌 ${erro?.message || 'erro desconhecido'}` }, { quoted: m }).catch(() => {});
                                }
                            }
                            break;
                        }

                        case 'toaudio': {
                            let progressoToaudio = null;
                            let tempInputToaudio = null;
                            let tempOutputToaudio = null;
                            try {
                                const mediaInfoToaudio = getTargetMedia(corpoMsg);
                                if (!mediaInfoToaudio || mediaInfoToaudio.type !== 'video') {
                                    return await sock.sendMessage(remoteJid, {
                                        text: `❌ Responda a um vídeo ou envie um vídeo com *${prefix}toaudio* na legenda para extrair o áudio em MP3.`
                                    }, { quoted: m });
                                }

                                const LIMITE_VIDEO_TOAUDIO_BYTES = 64 * 1024 * 1024;
                                const tamanhoDeclaradoToaudio = Number(mediaInfoToaudio.msg?.fileLength) || 0;
                                if (tamanhoDeclaradoToaudio > LIMITE_VIDEO_TOAUDIO_BYTES) {
                                    return await sock.sendMessage(remoteJid, {
                                        text: '❌ Este vídeo passa do limite de 64 MiB para conversão no celular. Envie um vídeo menor e tente novamente.'
                                    }, { quoted: m });
                                }

                                progressoToaudio = await criarBarraProgressoWhatsApp(remoteJid, m, 'Convertendo vídeo em áudio', 'audio');
                                await progressoToaudio.atualizar(8, 'Baixando vídeo...');
                                const streamToaudio = await downloadContentFromMessage(mediaInfoToaudio.msg, 'video');
                                const partesToaudio = [];
                                let bytesToaudio = 0;
                                for await (const chunk of streamToaudio) {
                                    bytesToaudio += chunk.length;
                                    if (bytesToaudio > LIMITE_VIDEO_TOAUDIO_BYTES) {
                                        throw new Error('O vídeo ultrapassou o limite de 64 MiB durante o download para proteger a memória do celular.');
                                    }
                                    partesToaudio.push(chunk);
                                    if (tamanhoDeclaradoToaudio > 0) {
                                        await progressoToaudio.atualizar(8 + Math.min(28, (bytesToaudio / tamanhoDeclaradoToaudio) * 28), 'Baixando vídeo...');
                                    }
                                }
                                const bufferVideoToaudio = Buffer.concat(partesToaudio, bytesToaudio);
                                if (!bufferVideoToaudio.length) throw new Error('O vídeo recebido está vazio.');

                                const baseToaudio = `toaudio_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                                tempInputToaudio = path.join(PASTA_TEMP, `${baseToaudio}.mp4`);
                                tempOutputToaudio = path.join(PASTA_TEMP, `${baseToaudio}.mp3`);
                                await writeFile(tempInputToaudio, bufferVideoToaudio);

                                await progressoToaudio.atualizar(46, 'Extraindo e convertendo a faixa de áudio para MP3...');
                                await executarProcesso('ffmpeg', [
                                    '-y', '-hide_banner', '-loglevel', 'error',
                                    '-i', tempInputToaudio,
                                    '-map', '0:a:0', '-vn',
                                    '-c:a', 'libmp3lame', '-q:a', '3',
                                    '-map_metadata', '-1',
                                    tempOutputToaudio
                                ], { timeoutMs: 240000, maxBuffer: 4 * 1024 * 1024 });

                                const bufferAudioToaudio = await readFile(tempOutputToaudio);
                                if (!bufferAudioToaudio.length) throw new Error('O FFmpeg gerou um MP3 vazio.');
                                await progressoToaudio.atualizar(88, 'Áudio pronto; enviando no WhatsApp...');

                                const nomeAudioToaudio = `ArleyBot_audio_${Date.now()}.mp3`;
                                if (bufferAudioToaudio.length > 16 * 1024 * 1024) {
                                    await sock.sendMessage(remoteJid, {
                                        document: bufferAudioToaudio,
                                        mimetype: 'audio/mpeg',
                                        fileName: nomeAudioToaudio,
                                        caption: '✅ Áudio extraído do vídeo. Enviei como arquivo para preservar o MP3 completo.'
                                    }, { quoted: m });
                                } else {
                                    await sock.sendMessage(remoteJid, {
                                        audio: bufferAudioToaudio,
                                        mimetype: 'audio/mpeg',
                                        fileName: nomeAudioToaudio,
                                        ptt: false
                                    }, { quoted: m });
                                }
                                await progressoToaudio.finalizar('MP3 enviado!');
                            } catch (erroToaudio) {
                                console.error('Erro no toaudio:', erroToaudio);
                                if (progressoToaudio) {
                                    await progressoToaudio.falhar(`Não consegui extrair o áudio: ${(erroToaudio?.message || 'erro desconhecido').slice(0, 220)}`);
                                } else {
                                    await sock.sendMessage(remoteJid, {
                                        text: `❌ Não consegui converter o vídeo em áudio.\n📌 ${erroToaudio?.message || 'Erro desconhecido.'}`
                                    }, { quoted: m }).catch(() => {});
                                }
                            } finally {
                                if (tempInputToaudio && existsSync(tempInputToaudio)) await unlink(tempInputToaudio).catch(() => {});
                                if (tempOutputToaudio && existsSync(tempOutputToaudio)) await unlink(tempOutputToaudio).catch(() => {});
                            }
                            break;
                        }

                        case 'estourar': {
                            const mediaInfoEstourar = getTargetMedia(corpoMsg);
                            if (!mediaInfoEstourar || !['audio', 'video'].includes(mediaInfoEstourar.type)) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `🔊 *Estourador de graves*\n\nResponda a um áudio ou vídeo com *${prefix}estourar*, ou envie a mídia com esse comando na legenda.\n\nModos: *${prefix}estourar leve*, *${prefix}estourar pesado* ou *${prefix}estourar absurdo*.\nO modo padrão é *pesado*.`
                                }, { quoted: m });
                            }

                            const estourarEhVideo = mediaInfoEstourar.type === 'video';
                            const nomeMidiaEstourar = estourarEhVideo ? 'vídeo' : 'áudio';
                            const modoEstourarInformado = textArgs.trim().toLowerCase();
                            const modoEstourar = modoEstourarInformado || 'pesado';
                            const filtrosEstourar = {
                                leve: 'highpass=f=30,bass=g=12:f=90:w=0.8,volume=5dB,acompressor=threshold=0.22:ratio=5:attack=5:release=100:makeup=3,asoftclip=type=tanh:threshold=0.75:output=0.95,alimiter=limit=0.98',
                                pesado: 'highpass=f=28,bass=g=18:f=85:w=0.8,equalizer=f=120:t=q:w=1:g=6,volume=9dB,asoftclip=type=hard:threshold=0.55:output=0.93,acompressor=threshold=0.13:ratio=8:attack=3:release=85:makeup=4,alimiter=limit=0.98',
                                absurdo: 'highpass=f=25,bass=g=22:f=75:w=0.9,equalizer=f=100:t=q:w=1.2:g=9,volume=14dB,asoftclip=type=hard:threshold=0.38:output=0.92,acompressor=threshold=0.10:ratio=12:attack=2:release=70:makeup=5,alimiter=limit=0.98'
                            };

                            if (!Object.prototype.hasOwnProperty.call(filtrosEstourar, modoEstourar)) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `❌ Modo inválido. Use *${prefix}estourar leve*, *${prefix}estourar pesado* ou *${prefix}estourar absurdo*.`
                                }, { quoted: m });
                            }

                            // Vídeos usam o limite padrão de mídia; áudios mantêm o limite menor.
                            const LIMITE_ESTOURAR_BYTES = estourarEhVideo ? 64 * 1024 * 1024 : 16 * 1024 * 1024;
                            const duracaoDeclaradaEstourar = Number(mediaInfoEstourar.msg?.seconds ?? mediaInfoEstourar.msg?.duration) || 0;
                            const tamanhoDeclaradoEstourar = Number(mediaInfoEstourar.msg?.fileLength) || 0;

                            if (duracaoDeclaradaEstourar > 180) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `❌ Esse ${nomeMidiaEstourar} passa de 3 minutos. Envie uma mídia de até 3 minutos para o processamento não pesar no celular.`
                                }, { quoted: m });
                            }
                            if (tamanhoDeclaradoEstourar > LIMITE_ESTOURAR_BYTES) {
                                const limiteMiBEstourar = estourarEhVideo ? 64 : 16;
                                return await sock.sendMessage(remoteJid, {
                                    text: `❌ Esse ${nomeMidiaEstourar} passa de ${limiteMiBEstourar} MiB. Envie um arquivo menor para proteger a memória do celular.`
                                }, { quoted: m });
                            }

                            const chaveEstourarAtivo = `estourar:${remoteJid}:${sender}`;
                            if (downloadsAtivos.has(chaveEstourarAtivo)) {
                                return await sock.sendMessage(remoteJid, {
                                    text: `⏳ Você já está processando uma mídia neste chat. Aguarde terminar.`
                                }, { quoted: m });
                            }
                            if (downloadsAtivos.size >= 2) {
                                return await sock.sendMessage(remoteJid, {
                                    text: '⏳ O bot já está processando duas mídias. Aguarde uma terminar e tente novamente.'
                                }, { quoted: m });
                            }

                            downloadsAtivos.add(chaveEstourarAtivo);
                            let progressoEstourar = null;
                            let tempInputEstourar = null;
                            let tempOutputEstourar = null;
                            try {
                                await mkdir(PASTA_TEMP, { recursive: true });
                                progressoEstourar = await criarBarraProgressoWhatsApp(
                                    remoteJid,
                                    m,
                                    estourarEhVideo ? 'Estourando o áudio do vídeo' : 'Estourando os graves do áudio',
                                    estourarEhVideo ? 'video' : 'audio'
                                );
                                await progressoEstourar.atualizar(8, `Baixando ${estourarEhVideo ? 'o vídeo' : 'o áudio'} original...`);

                                const tipoDownloadEstourar = estourarEhVideo ? 'video' : 'audio';
                                const streamEstourar = await downloadContentFromMessage(mediaInfoEstourar.msg, tipoDownloadEstourar);
                                const bufferOriginalEstourar = await streamParaBufferLimitado(
                                    streamEstourar,
                                    LIMITE_ESTOURAR_BYTES,
                                    `${nomeMidiaEstourar} para estourar`
                                );
                                if (!bufferOriginalEstourar.length) throw new Error(`O ${nomeMidiaEstourar} recebido está vazio. Tente responder novamente à mídia original.`);
                                await progressoEstourar.atualizar(32, 'Aplicando graves fortes e distorção...');

                                const baseEstourar = `estourar_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                                tempInputEstourar = path.join(PASTA_TEMP, `${baseEstourar}_entrada${estourarEhVideo ? '.mp4' : '.ogg'}`);
                                tempOutputEstourar = path.join(PASTA_TEMP, `${baseEstourar}_estourado${estourarEhVideo ? '.mp4' : '.mp3'}`);
                                await writeFile(tempInputEstourar, bufferOriginalEstourar);

                                // Quando o WhatsApp não informar a duração, consulta o arquivo com ffprobe.
                                if (!(duracaoDeclaradaEstourar > 0)) {
                                    try {
                                        const probeDuracaoEstourar = await executarProcesso('ffprobe', [
                                            '-v', 'error', '-show_entries', 'format=duration',
                                            '-of', 'default=noprint_wrappers=1:nokey=1', tempInputEstourar
                                        ], { timeoutMs: 15000, maxBuffer: 64 * 1024 });
                                        const duracaoDetectadaEstourar = Number(String(probeDuracaoEstourar.stdout || '').trim());
                                        if (Number.isFinite(duracaoDetectadaEstourar) && duracaoDetectadaEstourar > 180) {
                                            throw new Error(`Esse ${nomeMidiaEstourar} passa de 3 minutos. Envie uma mídia mais curta.`);
                                        }
                                    } catch (erroProbeEstourar) {
                                        if (String(erroProbeEstourar?.message || '').includes('passa de 3 minutos')) throw erroProbeEstourar;
                                        // Algumas instalações podem não incluir ffprobe; o FFmpeg ainda valida o arquivo.
                                    }
                                }

                                if (estourarEhVideo) {
                                    // Copia o vídeo sem recodificá-lo para poupar CPU; processa somente o áudio.
                                    await executarProcesso('ffmpeg', [
                                        '-y', '-hide_banner', '-loglevel', 'error',
                                        '-i', tempInputEstourar,
                                        '-map', '0:v:0', '-map', '0:a:0',
                                        '-c:v', 'copy',
                                        '-af', filtrosEstourar[modoEstourar],
                                        '-c:a', 'aac', '-b:a', '192k',
                                        '-ar', '44100', '-ac', '2',
                                        '-movflags', '+faststart',
                                        tempOutputEstourar
                                    ], { timeoutMs: 300000, maxBuffer: 4 * 1024 * 1024 });
                                } else {
                                    await executarProcesso('ffmpeg', [
                                        '-y', '-hide_banner', '-loglevel', 'error',
                                        '-i', tempInputEstourar,
                                        '-map', '0:a:0', '-vn',
                                        '-af', filtrosEstourar[modoEstourar],
                                        '-c:a', 'libmp3lame', '-b:a', '192k',
                                        '-ar', '44100', '-ac', '2',
                                        '-map_metadata', '-1',
                                        tempOutputEstourar
                                    ], { timeoutMs: 120000, maxBuffer: 4 * 1024 * 1024 });
                                }

                                const bufferEstourado = await readFile(tempOutputEstourar);
                                if (!bufferEstourado.length) throw new Error(`O FFmpeg não gerou o ${estourarEhVideo ? 'vídeo' : 'áudio'} processado.`);
                                if (estourarEhVideo && bufferEstourado.length > 64 * 1024 * 1024) {
                                    throw new Error('O vídeo processado ficou maior que 64 MiB. Tente um vídeo menor para proteger a memória do celular.');
                                }
                                await progressoEstourar.atualizar(90, `${estourarEhVideo ? 'Vídeo' : 'Áudio'} pronto; enviando no WhatsApp...`);

                                if (estourarEhVideo) {
                                    await sock.sendMessage(remoteJid, {
                                        video: bufferEstourado,
                                        mimetype: 'video/mp4',
                                        caption: `🔊 Vídeo com áudio estourado! Modo: ${modoEstourar}.`
                                    }, { quoted: m });
                                    await progressoEstourar.finalizar(`Vídeo enviado com o áudio estourado! Modo: ${modoEstourar}.`);
                                } else {
                                    await sock.sendMessage(remoteJid, {
                                        audio: bufferEstourado,
                                        mimetype: 'audio/mpeg',
                                        fileName: `ArleyBot_estourado_${Date.now()}.mp3`,
                                        ptt: false
                                    }, { quoted: m });
                                    await progressoEstourar.finalizar(`Áudio estourado enviado! Modo: ${modoEstourar}.`);
                                }
                            } catch (erroEstourar) {
                                console.error('Erro no comando estourar:', erroEstourar);
                                const detalheEstourar = String(erroEstourar?.message || 'erro desconhecido').slice(0, 220);
                                if (progressoEstourar) {
                                    await progressoEstourar.falhar(`Não consegui estourar esse ${nomeMidiaEstourar}: ${detalheEstourar}`);
                                } else {
                                    await sock.sendMessage(remoteJid, {
                                        text: `❌ Não consegui processar esse ${nomeMidiaEstourar}.\n📌 ${detalheEstourar}`
                                    }, { quoted: m }).catch(() => {});
                                }
                            } finally {
                                if (tempInputEstourar && existsSync(tempInputEstourar)) await unlink(tempInputEstourar).catch(() => {});
                                if (tempOutputEstourar && existsSync(tempOutputEstourar)) await unlink(tempOutputEstourar).catch(() => {});
                                downloadsAtivos.delete(chaveEstourarAtivo);
                            }
                            break;
                        }

                        case 'achatar': {
                            let progressoAchatar = null;
                            let tempInput = null;
                            let tempInputPreparado = null;
                            let tempOutput = null;
                            try {
                                const mediaInfoAchatar = getTargetMedia(corpoMsg);
                                if (!mediaInfoAchatar || !['image', 'video', 'sticker'].includes(mediaInfoAchatar.type)) {
                                    return await sock.sendMessage(remoteJid, {
                                        text: `😂 *Bora achatar essa mídia!*\n\nEnvie uma foto/vídeo com *${prefix}achatar* na legenda ou responda a uma foto, vídeo ou figurinha com *${prefix}achatar*.`
                                    }, { quoted: m });
                                }

                                const origemEhSticker = mediaInfoAchatar.type === 'sticker';
                                const tituloAchatar = origemEhSticker
                                    ? 'Achatando figurinha'
                                    : mediaInfoAchatar.type === 'video' ? 'Achatando vídeo' : 'Achatando foto';
                                // Usa a barra editável em vez de mandar uma mensagem de carregamento separada.
                                progressoAchatar = await criarBarraProgressoWhatsApp(remoteJid, m, tituloAchatar, origemEhSticker ? 'sticker' : mediaInfoAchatar.type === 'image' ? 'imagem' : 'video');
                                await progressoAchatar.atualizar(5, 'Preparando o download...');

                                const tipoDownloadAchatar = origemEhSticker ? 'sticker' : mediaInfoAchatar.type;
                                const streamAchatar = await downloadContentFromMessage(mediaInfoAchatar.msg, tipoDownloadAchatar);
                                const bufferOriginalAchatar = await streamParaBufferLimitado(
                                    streamAchatar,
                                    origemEhSticker ? 16 * 1024 * 1024 : LIMITE_BUFFER_MIDIA_BYTES,
                                    origemEhSticker ? 'figurinha' : 'mídia para achatar'
                                );
                                if (!bufferOriginalAchatar.length) throw new Error('A mídia recebida está vazia. Tente enviar a mídia novamente.');
                                await progressoAchatar.atualizar(22, 'Download concluído; validando a mídia...');

                                const baseAchatar = `achatar_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                                const extensaoEntrada = origemEhSticker ? 'webp' : mediaInfoAchatar.type === 'video' ? 'mp4' : 'jpg';
                                const extensaoSaida = origemEhSticker ? 'webp' : mediaInfoAchatar.type === 'video' ? 'mp4' : 'png';
                                tempInput = path.join(PASTA_TEMP, `${baseAchatar}_entrada.${extensaoEntrada}`);
                                tempOutput = path.join(PASTA_TEMP, `${baseAchatar}_achatada.${extensaoSaida}`);
                                await writeFile(tempInput, bufferOriginalAchatar);

                                let stickerOriginalInfo = null;
                                let stickerEraAnimado = false;
                                if (origemEhSticker) {
                                    stickerOriginalInfo = analisarWebP(bufferOriginalAchatar);
                                    if (!stickerOriginalInfo.valido) {
                                        throw new Error('A figurinha recebida não é um WebP válido. Tente responder novamente à figurinha original.');
                                    }
                                    stickerEraAnimado = Boolean(stickerOriginalInfo.animado && stickerOriginalInfo.quadros > 1);
                                    // Algumas figurinhas do WhatsApp têm chunks EXIF/metadados que certas
                                    // versões do FFmpeg no Android não conseguem decodificar. Guardamos
                                    // o original e uma cópia preparada para tentar os dois caminhos.
                                    tempInputPreparado = path.join(PASTA_TEMP, `${baseAchatar}_preparada.webp`);
                                    await writeFile(tempInputPreparado, prepararWebPParaFFmpeg(bufferOriginalAchatar));
                                }

                                await progressoAchatar.atualizar(32, origemEhSticker ? 'Preparando o WebP da figurinha...' : 'Convertendo a mídia...');

                                if (mediaInfoAchatar.type === 'image') {
                                    await executarProcesso('ffmpeg', [
                                        '-y', '-hide_banner', '-loglevel', 'error',
                                        '-i', tempInput,
                                        '-map', '0:v:0',
                                        '-vf', 'scale=iw:ih*0.35:flags=lanczos,setsar=1',
                                        '-frames:v', '1', '-an', '-compression_level', '6',
                                        tempOutput
                                    ], { timeoutMs: 90000 });

                                    const imagemAchata = await readFile(tempOutput);
                                    if (!imagemAchata.length) throw new Error('O FFmpeg gerou uma imagem vazia.');
                                    await progressoAchatar.atualizar(92, 'Foto achatada; enviando no WhatsApp...');
                                    await sock.sendMessage(remoteJid, {
                                        image: imagemAchata,
                                        caption: '🤣 *Foto achatada com sucesso!*'
                                    }, { quoted: m });
                                } else if (mediaInfoAchatar.type === 'video') {
                                    await progressoAchatar.atualizar(38, 'Achatando o quadro do vídeo...');
                                    await executarProcesso('ffmpeg', [
                                        '-y', '-hide_banner', '-loglevel', 'error',
                                        '-i', tempInput,
                                        '-map', '0:v:0', '-map', '0:a?',
                                        '-vf', 'scale=trunc(iw/2)*2:trunc(ih*0.35/2)*2:flags=lanczos,setsar=1',
                                        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22',
                                        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
                                        '-movflags', '+faststart',
                                        tempOutput
                                    ], { timeoutMs: 180000 });

                                    const videoAchata = await readFile(tempOutput);
                                    if (!videoAchata.length) throw new Error('O FFmpeg gerou um vídeo vazio.');
                                    await progressoAchatar.atualizar(92, 'Vídeo achatado; enviando no WhatsApp...');
                                    await sock.sendMessage(remoteJid, {
                                        video: videoAchata,
                                        caption: '🤣 *Vídeo achatado com sucesso!*'
                                    }, { quoted: m });
                                } else {
                                    const entradasWebP = [
                                        { nome: 'original', caminho: tempInput },
                                        { nome: 'WebP sem metadados', caminho: tempInputPreparado }
                                    ];
                                    let erroConversaoSticker = null;
                                    let webpAchata = null;

                                    if (stickerEraAnimado) {
                                        // Tenta o original e o WebP sem EXIF, pois há builds Android do
                                        // FFmpeg que falham com alguns chunks de figurinhas animadas.
                                        for (const entrada of entradasWebP) {
                                            try {
                                                await progressoAchatar.atualizar(42, `Convertendo animação (${entrada.nome})...`);
                                                if (existsSync(tempOutput)) await unlink(tempOutput).catch(() => {});
                                                await executarProcesso('ffmpeg', [
                                                    '-y', '-hide_banner', '-loglevel', 'error',
                                                    '-ignore_loop', '0', '-i', entrada.caminho,
                                                    '-map', '0:v:0',
                                                    '-vf', 'fps=12,scale=512:180:flags=lanczos,setsar=1',
                                                    '-an', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '75',
                                                    '-compression_level', '4', '-loop', '0', '-f', 'webp',
                                                    tempOutput
                                                ], { timeoutMs: 180000, maxBuffer: 4 * 1024 * 1024 });
                                                const candidato = await readFile(tempOutput);
                                                const infoCandidato = analisarWebP(candidato);
                                                if (!candidato.length || !infoCandidato.valido || !infoCandidato.animado || infoCandidato.quadros < 2) {
                                                    throw new Error('A saída não preservou os quadros da animação.');
                                                }
                                                webpAchata = candidato;
                                                erroConversaoSticker = null;
                                                break;
                                            } catch (erroTentativa) {
                                                erroConversaoSticker = erroTentativa;
                                                console.warn(`⚠️ .achatar: FFmpeg falhou com entrada ${entrada.nome}:`, erroTentativa?.message || erroTentativa);
                                            }
                                        }

                                        // Fallback opcional: ImageMagick consegue reconstruir alguns WebP
                                        // animados que o FFmpeg instalado no Android não abre.
                                        if (!webpAchata) {
                                            for (const tentativa of [
                                                { comando: 'magick', args: [tempInputPreparado, '-coalesce', '-resize', '512x180!', '-strip', '-loop', '0', tempOutput] },
                                                { comando: 'convert', args: [tempInputPreparado, '-coalesce', '-resize', '512x180!', '-strip', '-loop', '0', tempOutput] }
                                            ]) {
                                                try {
                                                    await progressoAchatar.atualizar(66, 'Tentando recuperar a animação...');
                                                    if (existsSync(tempOutput)) await unlink(tempOutput).catch(() => {});
                                                    await executarProcesso(tentativa.comando, tentativa.args, { timeoutMs: 120000, maxBuffer: 4 * 1024 * 1024 });
                                                    const candidato = await readFile(tempOutput);
                                                    const infoCandidato = analisarWebP(candidato);
                                                    if (!candidato.length || !infoCandidato.valido || !infoCandidato.animado || infoCandidato.quadros < 2) {
                                                        throw new Error('O resultado do ImageMagick não manteve a animação.');
                                                    }
                                                    webpAchata = candidato;
                                                    erroConversaoSticker = null;
                                                    break;
                                                } catch (erroTentativa) {
                                                    erroConversaoSticker = erroTentativa;
                                                    console.warn(`⚠️ .achatar: ${tentativa.comando} falhou ao recuperar a animação:`, erroTentativa?.message || erroTentativa);
                                                }
                                            }
                                        }

                                        if (!webpAchata) {
                                            throw new Error('Não consegui decodificar essa figurinha animada neste FFmpeg. Tente instalar o ImageMagick com `pkg install imagemagick` e reinicie o bot. Detalhe: ' + (erroConversaoSticker?.message || 'falha de decodificação').slice(0, 350));
                                        }

                                        await progressoAchatar.atualizar(88, 'Animação achatada; preparando a figurinha...');
                                        const stickerAnimadaAchata = adicionarExifFigurinhaAnimada(
                                            webpAchata, NOME_PACK_FIGURINHA, AUTOR_PACK_FIGURINHA
                                        );
                                        await sock.sendMessage(remoteJid, {
                                            sticker: stickerAnimadaAchata,
                                            isAnimated: true,
                                            mimetype: 'image/webp'
                                        }, { quoted: m });
                                    } else {
                                        // Para figurinhas estáticas, tenta FFmpeg com ambas as entradas
                                        // e depois ImageMagick/convert como alternativas locais.
                                        for (const entrada of entradasWebP) {
                                            try {
                                                await progressoAchatar.atualizar(48, `Convertendo figurinha (${entrada.nome})...`);
                                                if (existsSync(tempOutput)) await unlink(tempOutput).catch(() => {});
                                                await executarProcesso('ffmpeg', [
                                                    '-y', '-hide_banner', '-loglevel', 'error',
                                                    '-i', entrada.caminho,
                                                    '-map', '0:v:0',
                                                    '-vf', 'scale=512:180:flags=lanczos,setsar=1',
                                                    '-frames:v', '1', '-an', '-c:v', 'libwebp',
                                                    '-lossless', '0', '-q:v', '85', '-compression_level', '4',
                                                    tempOutput
                                                ], { timeoutMs: 90000, maxBuffer: 4 * 1024 * 1024 });
                                                const candidato = await readFile(tempOutput);
                                                if (!candidato.length || !analisarWebP(candidato).valido) throw new Error('O FFmpeg gerou um WebP inválido.');
                                                webpAchata = candidato;
                                                erroConversaoSticker = null;
                                                break;
                                            } catch (erroTentativa) {
                                                erroConversaoSticker = erroTentativa;
                                                console.warn(`⚠️ .achatar: FFmpeg falhou com entrada ${entrada.nome}:`, erroTentativa?.message || erroTentativa);
                                            }
                                        }

                                        if (!webpAchata) {
                                            for (const tentativa of [
                                                { comando: 'magick', args: [tempInputPreparado, '-resize', '512x180!', '-strip', tempOutput] },
                                                { comando: 'convert', args: [tempInputPreparado, '-resize', '512x180!', '-strip', tempOutput] }
                                            ]) {
                                                try {
                                                    await progressoAchatar.atualizar(70, `Tentando conversão alternativa (${tentativa.comando})...`);
                                                    if (existsSync(tempOutput)) await unlink(tempOutput).catch(() => {});
                                                    await executarProcesso(tentativa.comando, tentativa.args, { timeoutMs: 90000, maxBuffer: 4 * 1024 * 1024 });
                                                    const candidato = await readFile(tempOutput);
                                                    if (!candidato.length || !analisarWebP(candidato).valido) throw new Error('O conversor não gerou um WebP válido.');
                                                    webpAchata = candidato;
                                                    erroConversaoSticker = null;
                                                    break;
                                                } catch (erroTentativa) {
                                                    erroConversaoSticker = erroTentativa;
                                                    console.warn(`⚠️ .achatar: ${tentativa.comando} falhou:`, erroTentativa?.message || erroTentativa);
                                                }
                                            }
                                        }

                                        if (!webpAchata) {
                                            throw new Error('Não consegui ler esta figurinha WebP. O bot tentou o arquivo original, removeu os metadados e tentou conversores alternativos. Se necessário, instale ImageMagick com `pkg install imagemagick`. Detalhe: ' + (erroConversaoSticker?.message || 'falha de decodificação').slice(0, 350));
                                        }

                                        await progressoAchatar.atualizar(88, 'Figurinha achatada; preparando o envio...');
                                        const stickerEstaticaAchata = adicionarExifFigurinha(
                                            webpAchata, NOME_PACK_FIGURINHA, AUTOR_PACK_FIGURINHA
                                        );
                                        await sock.sendMessage(remoteJid, {
                                            sticker: stickerEstaticaAchata,
                                            isAnimated: false,
                                            mimetype: 'image/webp'
                                        }, { quoted: m });
                                    }
                                }
                                await progressoAchatar.finalizar('Mídia achatada e enviada!');
                            } catch (erro) {
                                console.error('Erro ao achatar mídia:', erro);
                                if (progressoAchatar) {
                                    await progressoAchatar.falhar(`Não consegui achatar: ${(erro?.message || 'erro desconhecido').replace(/\s+/g, ' ').slice(0, 220)}`).catch(() => {});
                                } else {
                                    await sock.sendMessage(remoteJid, {
                                        text: `❌ Não consegui achatar essa mídia.\n\n📌 ${erro?.message || 'Erro desconhecido.'}`
                                    }, { quoted: m }).catch(() => {});
                                }
                            } finally {
                                if (tempInput && existsSync(tempInput)) await unlink(tempInput).catch(() => {});
                                if (tempInputPreparado && existsSync(tempInputPreparado)) await unlink(tempInputPreparado).catch(() => {});
                                if (tempOutput && existsSync(tempOutput)) await unlink(tempOutput).catch(() => {});
                            }
                            break;
                        }

                        case 's':
                        case 'f': {
                            let progressoFigurinha = null;
                            try {
                                const mediaInfo = getTargetMedia(corpoMsg);
                                if (!mediaInfo) {
                                    return await sock.sendMessage(remoteJid, { text: `❌ Envie ou responda a uma imagem, vídeo ou visualização única com *${prefix}f*` }, { quoted: m });
                                }

                                if (mediaInfo.type === 'image') {
                                    progressoFigurinha = await criarBarraProgressoWhatsApp(remoteJid, m, 'Criando figurinha', 'sticker');
                                    await progressoFigurinha.atualizar(8, 'Baixando imagem...');
                                    const stream = await downloadContentFromMessage(mediaInfo.msg, 'image');
                                    const partes = [];
                                    let bytesImagem = 0;
                                    const tamanhoImagem = Number(mediaInfo.msg.fileLength) || 0;
                                    for await (const chunk of stream) {
                                        bytesImagem += chunk.length;
                                        if (bytesImagem > LIMITE_BUFFER_MIDIA_BYTES) {
                                            throw new Error('A imagem ultrapassou o limite de 64 MiB para proteger a memória do celular.');
                                        }
                                        partes.push(chunk);
                                        if (tamanhoImagem > 0) {
                                            await progressoFigurinha.atualizar(8 + Math.min(24, (bytesImagem / tamanhoImagem) * 24), 'Baixando imagem...');
                                        }
                                    }
                                    const buffer = Buffer.concat(partes, bytesImagem);
                                    if (!buffer.length) throw new Error('A imagem recebida está vazia.');

                                    const base = `sticker_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                                    const tempInput = path.join(PASTA_TEMP, `${base}.jpg`);
                                    const tempOutput = path.join(PASTA_TEMP, `${base}.webp`);
                                    try {
                                        await writeFile(tempInput, buffer);
                                        await progressoFigurinha.atualizar(38, 'Convertendo para WebP...');
                                        await executarComTentativas(() => executarProcesso('ffmpeg', [
                                            '-y', '-hide_banner', '-loglevel', 'error', '-i', tempInput,
                                            // Exatamente 512x512, sem cortar: preenche o quadrado achatando a proporção.
                                            '-vf', 'scale=512:512:flags=lanczos,setsar=1,format=yuv420p',
                                            '-frames:v', '1', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '90',
                                            '-compression_level', '2', '-an', tempOutput
                                        ], { timeoutMs: 60000 }), 2);
                                        const webpBuffer = await readFile(tempOutput);
                                        if (!webpBuffer.length) throw new Error('O FFmpeg gerou uma figurinha vazia.');
                                        const stickerFinal = adicionarExifFigurinha(webpBuffer, NOME_PACK_FIGURINHA, AUTOR_PACK_FIGURINHA);
                                        await progressoFigurinha.atualizar(94, 'Imagem convertida; enviando figurinha...');
                                        await sock.sendMessage(remoteJid, { sticker: stickerFinal, isAnimated: false, mimetype: 'image/webp' }, { quoted: m });
                                        await progressoFigurinha.finalizar('Figurinha enviada!');
                                    } finally {
                                        if (existsSync(tempInput)) await unlink(tempInput).catch(() => {});
                                        if (existsSync(tempOutput)) await unlink(tempOutput).catch(() => {});
                                    }
                                } else if (mediaInfo.type === 'video') {
                                    const duracao = Number(mediaInfo.msg.seconds) || 0;
                                    if (duracao > LIMITE_FIGURINHA_VIDEO_SEGUNDOS) {
                                        return await sock.sendMessage(remoteJid, { text: `❌ O vídeo é muito longo (${duracao}s). O limite máximo é de *${LIMITE_FIGURINHA_VIDEO_SEGUNDOS} segundos* para figurinhas animadas!` }, { quoted: m });
                                    }

                                    progressoFigurinha = await criarBarraProgressoWhatsApp(remoteJid, m, 'Criando figurinha animada', 'sticker');
                                    await progressoFigurinha.atualizar(6, 'Baixando vídeo...');

                                    const stream = await downloadContentFromMessage(mediaInfo.msg, 'video');
                                    const partes = [];
                                    let bytesVideo = 0;
                                    const tamanhoVideo = Number(mediaInfo.msg.fileLength) || 0;
                                    for await (const chunk of stream) {
                                        bytesVideo += chunk.length;
                                        if (bytesVideo > LIMITE_BUFFER_MIDIA_BYTES) {
                                            throw new Error('O vídeo ultrapassou o limite de 64 MiB para proteger a memória do celular.');
                                        }
                                        partes.push(chunk);
                                        if (tamanhoVideo > 0) {
                                            await progressoFigurinha.atualizar(6 + Math.min(22, (bytesVideo / tamanhoVideo) * 22), 'Baixando vídeo...');
                                        }
                                    }
                                    const buffer = Buffer.concat(partes, bytesVideo);
                                    if (!buffer.length) throw new Error('O vídeo recebido está vazio.');

                                    const base = `sticker_anim_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                                    const tempInput = path.join(PASTA_TEMP, `${base}.mp4`);
                                    const tempOutput = path.join(PASTA_TEMP, `${base}.webp`);

                                    try {
                                        await writeFile(tempInput, buffer);

                                        // =====================================================
                                        // 🎬 FIGURINHA ANIMADA — COMPATIBILIDADE WHATSAPP
                                        // =====================================================
                                        // O ponto mais importante é gerar um WebP ANIMADO de
                                        // verdade (VP8X + ANIM + vários ANMF) e nunca passar
                                        // esse arquivo pela função de EXIF das figurinhas
                                        // estáticas, pois ela pode destruir a animação.
                                        //
                                        // Mantemos o padrão quadrado 512x512 do bot, sem
                                        // bordas e sem crop.
                                        // =====================================================
                                        // Alvo de tamanho: até 1 MiB (1.024 KiB), priorizando qualidade e fluidez.
                                        // O esticamento direto para 512x512 é INTENCIONAL: esse é o efeito
                                        // engraçado do bot. Não preservar proporção nem adicionar margens.
                                        // Prioriza movimento suave: tenta manter 15 FPS enquanto reduz
                                        // qualidade/compressão. Só cai para 12 FPS nas últimas tentativas.
                                        // Nunca reduz para 2-8 FPS, pois isso faz a figurinha parecer um slideshow.
                                        // Se mesmo a compressão forte não couber em 1 MiB, falha com aviso
                                        // em vez de enviar uma animação travada.
                                        const perfisAnimacao = [
                                            { fps: 15, qualidade: 82 },
                                            { fps: 15, qualidade: 72 },
                                            { fps: 15, qualidade: 62 },
                                            { fps: 15, qualidade: 52 },
                                            { fps: 15, qualidade: 42 },
                                            { fps: 15, qualidade: 32 },
                                            { fps: 15, qualidade: 22 },
                                            { fps: 12, qualidade: 35 },
                                            { fps: 12, qualidade: 25 },
                                            { fps: 12, qualidade: 18 }
                                        ];
                                        const LIMITE_BYTES_STICKER_ANIMADA = 1024 * 1024;
                                        const MARGEM_SEGURANCA_STICKER = 2 * 1024;
                                        let webpBuffer = null;
                                        let info = null;

                                        for (let tentativa = 0; tentativa < perfisAnimacao.length; tentativa++) {
                                            const perfil = perfisAnimacao[tentativa];
                                            const inicioPerfil = 30 + (tentativa / perfisAnimacao.length) * 60;
                                            const faixaPerfil = 60 / perfisAnimacao.length;
                                            let bufferSaidaProgresso = '';
                                            const duracaoEstimativa = Math.max(1, Math.min(LIMITE_FIGURINHA_VIDEO_SEGUNDOS, duracao || LIMITE_FIGURINHA_VIDEO_SEGUNDOS));
                                            await progressoFigurinha.atualizar(inicioPerfil, `Otimizando vídeo a ${perfil.fps} FPS (perfil ${tentativa + 1}/${perfisAnimacao.length})...`);
                                            const ffmpegArgs = [
                                                '-y',
                                                '-hide_banner',
                                                '-loglevel', 'error',
                                                '-i', tempInput,
                                                '-map', '0:v:0',
                                                // Nunca ultrapassar 10 segundos, mesmo se a duração
                                                // informada pelo WhatsApp estiver arredondada/incorreta.
                                                '-t', String(LIMITE_FIGURINHA_VIDEO_SEGUNDOS),
                                                // Vídeos comuns não precisam de canal alfa; yuv420p
                                                // evita carregar alfa inútil e ajuda na compressão.
                                                '-vf', `fps=${perfil.fps},scale=512:512:flags=lanczos,format=yuv420p,setsar=1`,
                                                '-an',
                                                '-c:v', 'libwebp',
                                                '-lossless', '0',
                                                '-q:v', String(perfil.qualidade),
                                                '-compression_level', '6',
                                                '-loop', '0',
                                                '-f', 'webp',
                                                '-progress', 'pipe:1', '-nostats',
                                                tempOutput
                                            ];

                                            await executarComTentativas(
                                                () => executarProcesso('ffmpeg', ffmpegArgs, {
                                                    timeoutMs: 150000,
                                                    onStdout: (trecho) => {
                                                        bufferSaidaProgresso += String(trecho || '');
                                                        const linhas = bufferSaidaProgresso.split(/\r\n|\n|\r/);
                                                        bufferSaidaProgresso = linhas.pop() || '';
                                                        for (const linha of linhas) {
                                                            const correspondeTempo = linha.match(/^out_time_ms=(\d+)/);
                                                            if (correspondeTempo) {
                                                                const tempoSegundos = Number(correspondeTempo[1]) / 1000000;
                                                                const fracao = Math.max(0, Math.min(1, tempoSegundos / duracaoEstimativa));
                                                                void progressoFigurinha.atualizar(
                                                                    inicioPerfil + fracao * faixaPerfil,
                                                                    `Convertendo vídeo a ${perfil.fps} FPS (perfil ${tentativa + 1}/${perfisAnimacao.length})...`
                                                                );
                                                            }
                                                        }
                                                    }
                                                }),
                                                2
                                            );
                                            await progressoFigurinha.atualizar(inicioPerfil + faixaPerfil, `Verificando tamanho (perfil ${tentativa + 1}/${perfisAnimacao.length})...`);

                                            webpBuffer = await readFile(tempOutput);
                                            if (!webpBuffer.length) {
                                                throw new Error('O FFmpeg gerou uma figurinha vazia.');
                                            }

                                            info = analisarWebP(webpBuffer);
                                            if (!info.valido || !info.animado || info.quadros < 2) {
                                                if (tentativa < perfisAnimacao.length - 1) continue;
                                                throw new Error(
                                                    `O FFmpeg não gerou um WebP animado válido. Quadros detectados: ${info.quadros || 0}.`
                                                );
                                            }

                                            // Enviamos o WebP animado diretamente, sem reescrever os
                                            // chunks ANIM/ANMF com metadados extras. Isso minimiza o
                                            // risco de o WhatsApp interpretar somente o primeiro quadro.
                                            if (webpBuffer.length <= LIMITE_BYTES_STICKER_ANIMADA - MARGEM_SEGURANCA_STICKER) {
                                                break;
                                            }

                                            if (tentativa === perfisAnimacao.length - 1) {
                                                throw new Error(
                                                    `Não consegui reduzir a figurinha para menos de 1 MB após ${perfisAnimacao.length} tentativas (último tamanho: ${Math.ceil(webpBuffer.length / 1024)} KB). Tente um vídeo com menos movimento ou duração menor.`
                                                );
                                            }
                                        }

                                        // Não adicionamos EXIF ao WebP animado: enviamos os quadros
                                        // gerados pelo FFmpeg sem alterar sua estrutura interna.
                                        const stickerAnimadaFinal = webpBuffer;
                                        const infoFinal = analisarWebP(stickerAnimadaFinal);
                                        if (!infoFinal.valido || !infoFinal.animado || infoFinal.quadros < 2) {
                                            throw new Error('A figurinha perdeu a animação durante a conversão.');
                                        }
                                        if (stickerAnimadaFinal.length > LIMITE_BYTES_STICKER_ANIMADA) {
                                            throw new Error(
                                                `A figurinha animada ultrapassou 1 MB (${Math.ceil(stickerAnimadaFinal.length / 1024)} KB).`
                                            );
                                        }

                                        await progressoFigurinha.atualizar(95, 'Animação validada; enviando figurinha...');
                                        await sock.sendMessage(
                                            remoteJid,
                                            {
                                                sticker: stickerAnimadaFinal,
                                                isAnimated: true,
                                                mimetype: 'image/webp'
                                            },
                                            { quoted: m }
                                        );
                                        await progressoFigurinha.finalizar('Figurinha animada enviada!');
                                    } finally {
                                        if (existsSync(tempInput)) await unlink(tempInput).catch(() => {});
                                        if (existsSync(tempOutput)) await unlink(tempOutput).catch(() => {});
                                    }
                                } else {
                                    return await sock.sendMessage(remoteJid, { text: `❌ Este comando funciona com imagens e vídeos de até 10 segundos.` }, { quoted: m });
                                }
                            } catch (erro) {
                                console.error('Erro detalhado ao criar a figurinha:', erro);
                                await progressoFigurinha?.falhar(`Falha ao criar a figurinha: ${(erro?.message || 'erro desconhecido').slice(0, 180)}`);
                                await sock.sendMessage(remoteJid, { text: `❌ Não consegui criar a figurinha.\n\n📌 ${erro?.message || 'erro desconhecido'}` }, { quoted: m }).catch(() => {});
                            }
                            break;
                        }

                        case 'gpt':
                        case 'openai': {
                            if (!textArgs) {
                                return await sock.sendMessage(remoteJid, { text: `❌ Escreva uma pergunta para o GPT! Ex: *${prefix}gpt olá, tudo bem?*` }, { quoted: m });
                            }
                            if (!OPENAI_API_KEY) {
                                return await sock.sendMessage(remoteJid, { text: '❌ GPT não configurado. adicione OPENAI_API_KEY=sua_chave ao arquivo privado ~/.arleybot.env e reinicie o bot.' }, { quoted: m });
                            }
                            try {
                                const respostaApi = await fetchIAComTimeout('https://api.openai.com/v1/responses', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
                                    body: JSON.stringify({ model: OPENAI_MODEL, instructions: INSTRUCOES_IA_NATURAL, input: textArgs, max_output_tokens: 1024 })
                                });
                                const json = await respostaApi.json().catch(() => ({}));
                                if (!respostaApi.ok) {
                                    console.error('GPT API HTTP', respostaApi.status, json);
                                    const detalhe = json?.error?.message || `HTTP ${respostaApi.status}`;
                                    return await sock.sendMessage(remoteJid, { text: `❌ O GPT recusou a solicitação.\n\n📌 ${detalhe}` }, { quoted: m });
                                }
                                const resposta = (json.output || []).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text || '').join('\n').trim() || json.output_text?.trim();
                                if (!resposta) return await sock.sendMessage(remoteJid, { text: '❌ O GPT não retornou texto utilizável.' }, { quoted: m });
                                return await sock.sendMessage(remoteJid, { text: resposta });
                            } catch (erro) {
                                console.error('Erro no GPT:', erro);
                                return await sock.sendMessage(remoteJid, { text: `❌ Erro ao comunicar com a API do GPT.\n📌 ${erro?.name === 'AbortError' ? 'A API demorou mais de 25 segundos e a chamada foi cancelada; tente novamente.' : (erro?.message || 'erro desconhecido')}` }, { quoted: m });
                            }
                        }

                        case 'grok':
                        case 'xai': {
                            if (!textArgs) {
                                return await sock.sendMessage(remoteJid, { text: `❌ Escreva uma pergunta para o Grok! Ex: *${prefix}grok olá, tudo bem?*` }, { quoted: m });
                            }
                            if (!XAI_API_KEY) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Grok não configurado. adicione XAI_API_KEY=sua_chave ao arquivo privado ~/.arleybot.env e reinicie o bot.' }, { quoted: m });
                            }
                            try {
                                const respostaApi = await fetchIAComTimeout('https://api.x.ai/v1/responses', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${XAI_API_KEY}` },
                                    body: JSON.stringify({ model: XAI_MODEL, instructions: INSTRUCOES_IA_NATURAL, input: textArgs, max_output_tokens: 1024 })
                                });
                                const json = await respostaApi.json().catch(() => ({}));
                                if (!respostaApi.ok) {
                                    console.error('Grok API HTTP', respostaApi.status, json?.error?.message || respostaApi.status);
                                    const detalhe = json?.error?.message || `HTTP ${respostaApi.status}`;
                                    return await sock.sendMessage(remoteJid, { text: `❌ Não consegui responder agora.\n📌 ${detalhe}` }, { quoted: m });
                                }
                                const resposta = (json.output || []).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text || '').join('\n').trim() || json.output_text?.trim();
                                if (!resposta) return await sock.sendMessage(remoteJid, { text: 'Não consegui montar uma resposta dessa vez. Tenta de novo.' }, { quoted: m });
                                return await sock.sendMessage(remoteJid, { text: resposta });
                            } catch (erro) {
                                console.error('Erro no Grok:', erro);
                                return await sock.sendMessage(remoteJid, { text: `❌ Erro ao comunicar com a API do Grok.\n📌 ${erro?.name === 'AbortError' ? 'A API demorou mais de 25 segundos e a chamada foi cancelada; tente novamente.' : (erro?.message || 'erro desconhecido')}` }, { quoted: m });
                            }
                        }

                        case 'genini': // aceita também o erro de digitação usado com frequência
                        case 'gemini':
                            if (!textArgs) {
                                return await sock.sendMessage(remoteJid, { text: `❌ Escreva uma pergunta para o Gemini! Ex: *${prefix}gemini olá, tudo bem?*` }, { quoted: m });
                            }
                            try {
                                if (!GEMINI_API_KEY) {
                                    return await sock.sendMessage(remoteJid, {
                                        text: '❌ A chave do Gemini não está configurada. adicione GEMINI_API_KEY=sua_chave ao arquivo privado ~/.arleybot.env e reinicie o bot.'
                                    }, { quoted: m });
                                }

                                const respostaApi = await fetchIAComTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        'x-goog-api-key': GEMINI_API_KEY
                                    },
                                    body: JSON.stringify({
                                        systemInstruction: {
                                            parts: [{ text: INSTRUCOES_IA_NATURAL }]
                                        },
                                        contents: [{
                                            role: 'user',
                                            parts: [{ text: textArgs }]
                                        }],
                                        generationConfig: {
                                            temperature: 0.8,
                                            maxOutputTokens: 1024
                                        }
                                    })
                                });

                                const resultadoJson = await respostaApi.json().catch(() => ({}));

                                if (!respostaApi.ok) {
                                    console.error('Gemini HTTP', respostaApi.status, resultadoJson);
                                    const detalhe = resultadoJson?.error?.message || `HTTP ${respostaApi.status}`;
                                    return await sock.sendMessage(remoteJid, {
                                        text: `❌ O Gemini recusou a solicitação.\n\n📌 ${detalhe}`
                                    }, { quoted: m });
                                }

                                const textoGerado = resultadoJson.candidates
                                    ?.flatMap(c => c?.content?.parts || [])
                                    ?.map(p => p?.text || '')
                                    ?.join('')
                                    ?.trim();

                                if (!textoGerado) {
                                    console.error('Resposta Gemini sem texto:', JSON.stringify(resultadoJson, null, 2));
                                    return await sock.sendMessage(remoteJid, {
                                        text: '❌ A API do Gemini respondeu, mas não retornou texto utilizável.'
                                    }, { quoted: m });
                                }

                                await sock.sendMessage(remoteJid, { text: textoGerado });
                            } catch (erro) {
                                console.error('Erro no Gemini:', erro);
                                await sock.sendMessage(remoteJid, {
                                    text: `❌ Erro ao comunicar com a API do Gemini.\n\n📌 ${erro?.message || 'erro desconhecido'}`
                                }, { quoted: m });
                            }
                            break;

                        case 'yt':
                        case 'youtube': {
                            if (!textArgs) {
                                return await sock.sendMessage(remoteJid, { text: `❌ Escreva o nome do vídeo ou música! Ex: *${prefix}yt Mc IG*` }, { quoted: m });
                            }
                            let progressoYouTube = null;
                            try {
                                progressoYouTube = await criarBarraProgressoWhatsApp(remoteJid, m, 'Pesquisando no YouTube', 'audio');
                                await progressoYouTube.atualizar(18, `Procurando: ${textArgs.slice(0, 80)}...`);
                                const pesquisa = await ytSearch(textArgs);
                                if (!pesquisa || pesquisa.videos.length === 0) {
                                    await progressoYouTube.falhar('Nenhum vídeo encontrado com esse nome.');
                                    return;
                                }

                                const video = pesquisa.videos[0];
                                guardarPendenciaYouTube(userGroupKey, {
                                    url: video.url,
                                    title: video.title,
                                    author: video.author.name,
                                    timestamp: video.timestamp,
                                    thumbnail: video.thumbnail
                                });

                                await progressoYouTube.atualizar(78, 'Vídeo encontrado; preparando a confirmação...');
                                const mensagemConfirmacao = `🎵 *YOUTUBE - CONFIRMAÇÃO* 🎵\n\n*Título:* ${video.title}\n*Canal:* ${video.author.name}\n*Duração:* ${video.timestamp}\n\n❓ *É este vídeo que você quer transformar em MP3?*`;

                                await enviarBotoesWhatsApp(remoteJid, mensagemConfirmacao, [
                                    { id: `${prefix}sim`, text: '✅ Baixar MP3' },
                                    { id: `${prefix}nao`, text: '❌ Cancelar' }
                                ], { quoted: m }, { image: { url: video.thumbnail } });
                                await progressoYouTube.finalizar('Pesquisa concluída! Confira o vídeo enviado.');
                            } catch (erro) {
                                console.error('Erro na pesquisa do YouTube:', erro);
                                await progressoYouTube?.falhar('Erro ao pesquisar no YouTube.');
                                await sock.sendMessage(remoteJid, { text: `❌ Ocorreu um erro ao pesquisar o vídeo no YouTube.\n\n📌 ${erro?.message || 'Erro desconhecido.'}` }, { quoted: m });
                            }
                            break;
                        }

                        // Os comandos de mídia adulta foram desativados nesta compilação.
                        // A proteção local `.antiporno` continua disponível para moderar grupos.
                        case 'nfsw':
                        case 'nfsw1':
                        case 'menunfsw':
                        case 'menunsfw':
                        case 'gifporn1':
                        case 'gifhentai':
                        case 'gifahegao':
                        case 'gifecchi':
                        case 'gifcum':
                        case 'gifwaifu':
                        case 'gifanal':
                        case 'gifblowjob':
                        case 'gifpussy':
                        case 'gifboobs':
                        case 'gifass':
                        case 'gifsex':
                        case 'gifbdsm':
                        case 'gifbondage':
                        case 'gifmasturbation':
                        case 'gifhandjob':
                        case 'giffootjob':
                        case 'gifthighs':
                        case 'giffeet':
                        case 'gifmilf':
                        case 'giftentacles':
                        case 'giforgy':
                        case 'gifgangbang':
                        case 'gifdoggystyle':
                        case 'gifcowgirl':
                        case 'gifreversecowgirl':
                        case 'gifcreampie':
                        case 'giffacial':
                        case 'gifsquirting':
                        case 'gifbigbreasts':
                        case 'gifsmallbreasts':
                        case 'gifnude':
                        case 'giftopless':
                        case 'gifmaid':
                        case 'gifelf':
                        case 'gifcatgirl':
                        case 'gifsuccubus':
                        case 'gifmonstergirl':
                        case 'gifcuminside':
                        case 'gifcuminmouth':
                        case 'gifcumonbody':
                        case 'gifpussyjuice':
                        case 'giflingerie':
                        case 'gifpanties':
                        case 'gifbikini':
                        case 'gifnipples':
                        case 'gifpublic':
                        case 'gifnakedapron':
                        case 'gifvaginal':
                        case 'gifpenetration':
                        case 'gifthreesome':
                        case 'giforgasm':
                        case 'gifbukkake':
                        case 'gifpaizuri':
                        case 'gifnakadashi':
                        case 'gifpov':
                        case 'gifsexfrombehind':
                        case 'gifcumonbreasts':
                        case 'gifcumontongue':
                        case 'gifbreastgrab':
                        case 'gifspreadpussy':
                        case 'gifspanking':
                        case 'gifsextoy':
                        case 'gifpublicsex':
                        case 'porn1':
                        case 'hentai':
                        case 'ahegao':
                        case 'ecchi':
                        case 'cum':
                        case 'waifu':
                        case 'anal':
                        case 'blowjob':
                        case 'pussy':
                        case 'boobs':
                        case 'ass':
                        case 'sex':
                        case 'bdsm':
                        case 'bondage':
                        case 'masturbation':
                        case 'handjob':
                        case 'footjob':
                        case 'thighs':
                        case 'feet':
                        case 'milf':
                        case 'tentacles':
                        case 'orgy':
                        case 'gangbang':
                        case 'doggystyle':
                        case 'cowgirl':
                        case 'reversecowgirl':
                        case 'creampie':
                        case 'facial':
                        case 'squirting':
                        case 'bigbreasts':
                        case 'smallbreasts':
                        case 'nude':
                        case 'topless':
                        case 'maid':
                        case 'elf':
                        case 'catgirl':
                        case 'succubus':
                        case 'monstergirl':
                        case 'cuminside':
                        case 'cuminmouth':
                        case 'cumonbody':
                        case 'pussyjuice':
                        case 'lingerie':
                        case 'panties':
                        case 'bikini':
                        case 'nipples':
                        case 'public':
                        case 'nakedapron':
                        case 'vaginal':
                        case 'penetration':
                        case 'threesome':
                        case 'orgasm':
                        case 'bukkake':
                        case 'paizuri':
                        case 'nakadashi':
                        case 'pov':
                        case 'sexfrombehind':
                        case 'cumonbreasts':
                        case 'cumontongue':
                        case 'breastgrab':
                        case 'spreadpussy':
                        case 'spanking':
                        case 'sextoy':
                        case 'publicsex':
                        {
                            return await sock.sendMessage(remoteJid, {
                                text: '🔒 Os comandos de mídia adulta estão desativados nesta compilação. A proteção .antiporno continua disponível.'
                            }, { quoted: m });
                        }

                        case 'antiporno': {
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ O antiporno só funciona em grupos.' }, { quoted: m });
                            }
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores do grupo ou o dono do bot podem configurar o antiporno.' }, { quoted: m });
                            }

                            const acaoAntiPorno = String(textArgs || '').trim().toLowerCase();
                            if (!dadosGlobais.antiPornoGrupos || typeof dadosGlobais.antiPornoGrupos !== 'object') dadosGlobais.antiPornoGrupos = {};

                            if (acaoAntiPorno === 'on' || acaoAntiPorno === 'ativar') {
                                let metaAnti;
                                try { metaAnti = await obterMetadadosGrupoComTimeout(remoteJid); }
                                catch (erroMeta) {
                                    return await sock.sendMessage(remoteJid, { text: '❌ Não consegui verificar as permissões do grupo. Tente novamente.' }, { quoted: m });
                                }
                                const idsBotAnti = [getBotJid(), sock.user?.id].filter(Boolean);
                                const botAnti = (metaAnti.participants || []).find(p =>
                                    [p?.id, p?.jid, p?.phoneNumber, p?.lid].filter(Boolean).some(a =>
                                        idsBotAnti.some(b => a === b || normalizarJid(a) === normalizarJid(b))
                                    )
                                );
                                if (!(botAnti?.admin === 'admin' || botAnti?.admin === 'superadmin')) {
                                    return await sock.sendMessage(remoteJid, { text: '❌ Para apagar mensagens e remover membros, primeiro torne o ArleyBot administrador do grupo.' }, { quoted: m });
                                }
                                dadosGlobais.antiPornoGrupos[remoteJid] = true;
                                await salvarDadosBot(dadosGlobais);
                                return await sock.sendMessage(remoteJid, {
                                    text: `✅ *ANTIPORNO LOCAL ATIVADO!*

🔒 As imagens, figurinhas e até 3 quadros de vídeos serão analisados no próprio celular. Nenhuma mídia será enviada a uma API de classificação.

🚫 Quando *Porn* ou *Hentai* atingir confiança de pelo menos ${(ANTIPORNO_LIMIAR * 100).toFixed(0)}%, o bot tentará apagar a mensagem e remover o autor.
⚠️ O classificador pode errar; administradores e dono não recebem punição automática. O bot precisa continuar como administrador.`,
                                }, { quoted: m });
                            }

                            if (acaoAntiPorno === 'off' || acaoAntiPorno === 'desativar') {
                                delete dadosGlobais.antiPornoGrupos[remoteJid];
                                await salvarDadosBot(dadosGlobais);
                                return await sock.sendMessage(remoteJid, { text: '⚠️ *ANTIPORNO LOCAL DESATIVADO* neste grupo.' }, { quoted: m });
                            }

                            if (acaoAntiPorno === 'status' || !acaoAntiPorno) {
                                const ativo = !!dadosGlobais.antiPornoGrupos[remoteJid];
                                return await sock.sendMessage(remoteJid, {
                                    text: `🛡️ *ANTIPORNO LOCAL*

Estado: *${ativo ? 'ATIVADO ✅' : 'DESATIVADO ❌'}*
Método: análise local por NSFWJS/TensorFlow.js (CPU)
Limiar: ${(ANTIPORNO_LIMIAR * 100).toFixed(0)}%

Use *${prefix}antiporno on* ou *${prefix}antiporno off*.`,
                                }, { quoted: m });
                            }

                            return await sock.sendMessage(remoteJid, { text: `Uso: *${prefix}antiporno on*, *${prefix}antiporno off* ou *${prefix}antiporno status*.` }, { quoted: m });
                        }

                        case 'antispam':
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Só funciona em grupos.' }, { quoted: m });
                            }
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem usar este comando.' }, { quoted: m });
                            }

                            if (textArgs === 'on') {
                                gruposAntiSpamAtivo.add(remoteJid);
                                if (!dadosGlobais.antiSpamGrupos || typeof dadosGlobais.antiSpamGrupos !== 'object') dadosGlobais.antiSpamGrupos = {};
                                dadosGlobais.antiSpamGrupos[remoteJid] = true;
                                await salvarDadosBot(dadosGlobais);
                                await sock.sendMessage(remoteJid, { text: '🛡 *Anti-Spam ATIVADO* neste grupo!' }, { quoted: m });
                            } else if (textArgs === 'off') {
                                gruposAntiSpamAtivo.delete(remoteJid);
                                if (!dadosGlobais.antiSpamGrupos || typeof dadosGlobais.antiSpamGrupos !== 'object') dadosGlobais.antiSpamGrupos = {};
                                delete dadosGlobais.antiSpamGrupos[remoteJid];
                                await salvarDadosBot(dadosGlobais);
                                await sock.sendMessage(remoteJid, { text: '⚠️ *Anti-Spam DESATIVADO* neste grupo.' }, { quoted: m });
                            } else {
                                await sock.sendMessage(remoteJid, { text: `Como usar: *${prefix}antispam on* ou *${prefix}antispam off*` }, { quoted: m });
                            }
                            break;

                        case 'mute':
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Só funciona em grupos.' }, { quoted: m });
                            }
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem mutar membros.' }, { quoted: m });
                            }

                            const mencionadoMute = await obterMencionado(corpoMsg, m);
                            if (!mencionadoMute) {
                                return await sock.sendMessage(remoteJid, { text: `❌ Marque alguém ou responda à mensagem dele! Ex: *${prefix}mute @usuario*` }, { quoted: m });
                            }

                            const jidCanonicoMute = await resolverJidCanonicoGrupo(remoteJid, mencionadoMute, true);
                            if (jidCanonicoMute && jidCanonicoMute !== mencionadoMute) {
                                await migrarDadosIdentidadeGrupo(remoteJid, mencionadoMute, jidCanonicoMute);
                            }
                            const cleanMuted = normalizarJid(jidCanonicoMute);
                            const chaveMute = `${remoteJid}_${cleanMuted}`;
                            const muteExistente = dadosGlobais.usuariosMutados[chaveMute];
                            const mutePermanenteExistente = muteExistente === 'permanente';
                            const muteTemporarioAtivo = Number.isFinite(Number(muteExistente)) && Number(muteExistente) > Date.now();
                            if (mutePermanenteExistente || muteTemporarioAtivo) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Este utilizador já está mutado!' }, { quoted: m });
                            }
                            // Apaga um mute temporário expirado que ainda não tinha sido limpo por uma mensagem.
                            if (muteExistente !== undefined) delete dadosGlobais.usuariosMutados[chaveMute];

                            dadosGlobais.usuariosMutados[chaveMute] = 'permanente';
                            await salvarDadosBot(dadosGlobais);

                            await sock.sendMessage(
                                remoteJid,
                                {
                                    text: `🤐 *@${cleanMuted}* foi mutado.`,
                                    mentions: [jidCanonicoMute]
                                },
                                { quoted: m }
                            );
                            break;

                        case 'unmute':
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Só funciona em grupos.' }, { quoted: m });
                            }
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem desmutar membros.' }, { quoted: m });
                            }

                            const mencionadoUnmute = await obterMencionado(corpoMsg, m);
                            if (!mencionadoUnmute) {
                                return await sock.sendMessage(remoteJid, { text: `❌ Marque alguém ou responda à mensagem dele! Ex: *${prefix}unmute @usuario*` }, { quoted: m });
                            }

                            const jidCanonicoUnmute = await resolverJidCanonicoGrupo(remoteJid, mencionadoUnmute, true);
                            if (jidCanonicoUnmute && jidCanonicoUnmute !== mencionadoUnmute) {
                                await migrarDadosIdentidadeGrupo(remoteJid, mencionadoUnmute, jidCanonicoUnmute);
                            }
                            const cleanUnmuted = normalizarJid(jidCanonicoUnmute);
                            const chaveUnmute = `${remoteJid}_${cleanUnmuted}`;
                            const muteAtualUnmute = dadosGlobais.usuariosMutados[chaveUnmute];
                            const muteTemporarioAtivoUnmute = Number.isFinite(Number(muteAtualUnmute)) && Number(muteAtualUnmute) > Date.now();
                            if (muteAtualUnmute !== 'permanente' && !muteTemporarioAtivoUnmute) {
                                if (muteAtualUnmute !== undefined) {
                                    delete dadosGlobais.usuariosMutados[chaveUnmute];
                                    await salvarDadosBot(dadosGlobais);
                                }
                                return await sock.sendMessage(remoteJid, { text: '❌ Este utilizador não está mutado!' }, { quoted: m });
                            }

                            delete dadosGlobais.usuariosMutados[chaveUnmute];
                            await salvarDadosBot(dadosGlobais);

                            await sock.sendMessage(
                                remoteJid,
                                {
                                    text: `✅ *@${cleanUnmuted}* foi desmutado.`,
                                    mentions: [jidCanonicoUnmute]
                                },
                                { quoted: m }
                            );
                            break;

                        case 'promover':
                        case 'promote':
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            }
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem promover membros.' }, { quoted: m });
                            }

                            try {
                                const mencionadoPromover = await obterMencionado(corpoMsg, m);
                                if (!mencionadoPromover) {
                                    return await sock.sendMessage(remoteJid, { text: `❌ Marque alguém ou responda à mensagem!` }, { quoted: m });
                                }

                                const participantesPromover = await obterParticipantes(remoteJid);
                                const infoUserPromover = participantesPromover.find(p => normalizarJid(p.id) === normalizarJid(mencionadoPromover));
                                if (infoUserPromover && (infoUserPromover.admin === 'admin' || infoUserPromover.admin === 'superadmin')) {
                                    return await sock.sendMessage(remoteJid, { text: `❌ Este utilizador já é administrador!` }, { quoted: m });
                                }

                                await sock.groupParticipantsUpdate(remoteJid, [mencionadoPromover], 'promote');
                                await sock.sendMessage(
                                    remoteJid,
                                    {
                                        text: `👑 *@${normalizarJid(mencionadoPromover)}* foi promovido a administrador!`,
                                        mentions: [mencionadoPromover]
                                    },
                                    { quoted: m }
                                );
                            } catch (erro) {
                                console.error('Erro no promote:', erro);
                                await sock.sendMessage(remoteJid, { text: '❌ Não consegui promover esse utilizador. Verifique se tem permissão no grupo.' }, { quoted: m });
                            }
                            break;

                        case 'rebaixar':
                        case 'demote':
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            }
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem rebaixar membros.' }, { quoted: m });
                            }

                            try {
                                const mencionadoRebaixar = await obterMencionado(corpoMsg, m);
                                if (!mencionadoRebaixar) {
                                    return await sock.sendMessage(remoteJid, { text: `❌ Marque alguém ou responda à mensagem!` }, { quoted: m });
                                }

                                const participantesRebaixar = await obterParticipantes(remoteJid);
                                const infoUserRebaixar = participantesRebaixar.find(p => normalizarJid(p.id) === normalizarJid(mencionadoRebaixar));
                                if (!infoUserRebaixar || !infoUserRebaixar.admin) {
                                    return await sock.sendMessage(remoteJid, { text: `❌ Este utilizador não é administrador!` }, { quoted: m });
                                }

                                await sock.groupParticipantsUpdate(remoteJid, [mencionadoRebaixar], 'demote');
                                await sock.sendMessage(
                                    remoteJid,
                                    {
                                        text: `🔻 *@${normalizarJid(mencionadoRebaixar)}* foi rebaixado de administrador.`,
                                        mentions: [mencionadoRebaixar]
                                    },
                                    { quoted: m }
                                );
                            } catch (erro) {
                                console.error('Erro no demote:', erro);
                                await sock.sendMessage(remoteJid, { text: '❌ Não consegui rebaixar esse utilizador.' }, { quoted: m });
                            }
                            break;

                        case 'ban':
                        case 'kick':
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            }
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem banir membros.' }, { quoted: m });
                            }

                            try {
                                const mencionadoBan = await obterMencionado(corpoMsg, m);
                                if (!mencionadoBan) {
                                    return await sock.sendMessage(remoteJid, { text: `❌ Marque alguém ou responda à mensagem!` }, { quoted: m });
                                }

                                await sock.groupParticipantsUpdate(remoteJid, [mencionadoBan], 'remove');
                                await sock.sendMessage(
                                    remoteJid,
                                    {
                                        text: `🚫 *@${normalizarJid(mencionadoBan)}* foi removido do grupo.`,
                                        mentions: [mencionadoBan]
                                    },
                                    { quoted: m }
                                );
                            } catch (erro) {
                                console.error('Erro no ban:', erro);
                                await sock.sendMessage(remoteJid, { text: '❌ Não consegui remover esse utilizador.' }, { quoted: m });
                            }
                            break;

                        case 'add':
                            if (!isGroup) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Este comando só funciona em grupos.' }, { quoted: m });
                            }
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem adicionar membros.' }, { quoted: m });
                            }

                            try {
                                if (!textArgs) {
                                    const listaRemovidos = removidosRecentes[remoteJid] || [];
                                    if (listaRemovidos.length === 0) {
                                        return await sock.sendMessage(remoteJid, { text: '❌ Não há registro de participantes removidos recentemente neste grupo.' }, { quoted: m });
                                    }

                                    let mensagemLista = `📋 *PARTICIPANTES REMOVIDOS RECENTEMENTE*\n\n`;
                                    listaRemovidos.forEach((jid, index) => {
                                        mensagemLista += `*${index + 1}.* @${jid.split('@')[0]}\n`;
                                    });
                                    mensagemLista += `\n👉 Responda apenas com o *número* (1 a ${listaRemovidos.length}) para adicionar o participante de volta.`;

                                    limparCachesTemporarios();
                                    if (!Object.prototype.hasOwnProperty.call(aguardandoSelecaoAdd, userGroupKey) && Object.keys(aguardandoSelecaoAdd).length >= MAX_SELECOES_ADD_PENDENTES) {
                                        delete aguardandoSelecaoAdd[Object.keys(aguardandoSelecaoAdd)[0]];
                                    }
                                    aguardandoSelecaoAdd[userGroupKey] = { lista: listaRemovidos, expiraEm: Date.now() + TTL_SELECAO_ADD_MS };

                                    return await sock.sendMessage(remoteJid, {
                                        text: mensagemLista,
                                        mentions: listaRemovidos
                                    }, { quoted: m });
                                }

                                const numero = textArgs.replace(/[^\d]/g, '');
                                if (numero.length < 8 || numero.length > 15) {
                                    return await sock.sendMessage(remoteJid, { text: '❌ Número inválido. Use com DDI.' }, { quoted: m });
                                }

                                const jidAdd = `${numero}@s.whatsapp.net`;
                                await sock.groupParticipantsUpdate(remoteJid, [jidAdd], 'add');
                                await sock.sendMessage(
                                    remoteJid,
                                    {
                                        text: `✅ Solicitação para adicionar *@${numero}* enviada!`,
                                        mentions: [jidAdd]
                                    },
                                    { quoted: m }
                                );
                            } catch (erro) {
                                console.error('Erro no add:', erro);
                                await sock.sendMessage(remoteJid, { text: '❌ Não consegui adicionar esse número.' }, { quoted: m });
                            }
                            break;

                        case 'ping': {
                            const inicioPing = Date.now();
                            const timestampMensagem = Number(m.messageTimestamp || 0) * 1000;
                            const atrasoProcessamento = timestampMensagem > 0 ? Math.max(0, inicioPing - timestampMensagem) : null;
                            let estadoSocket = 'não disponível';
                            try {
                                const estado = obterReadyStateWebSocket(sock);
                                if (estado === 1) estadoSocket = 'conectado';
                                else if (estado === 0) estadoSocket = 'conectando';
                                else if (estado === 2) estadoSocket = 'encerrando';
                                else if (estado === 3) estadoSocket = 'desconectado';
                                else if (sockAtual === sock && socketAberto) estadoSocket = 'conectado (evento open; estado interno não exposto)';
                            } catch (_) {}
                            let textoPing = `🏓 *PONG — ARLEYBOT ${ARLEYBOT_VERSION}*\n\n🔌 Conexão: *${estadoSocket}*`;
                            try {
                                const respostaPing = await sock.sendMessage(remoteJid, { text: textoPing }, { quoted: m });
                                const latenciaEnvio = Date.now() - inicioPing;
                                const classificar = (ms) => ms < 500 ? '🟢 Boa' : ms < 1500 ? '🟡 Instável/moderada' : '🔴 Ruim/lenta';
                                const atrasoTexto = atrasoProcessamento === null ? 'indisponível' : `${atrasoProcessamento} ms`;
                                const textoFinal = `🏓 *PONG — ARLEYBOT ${ARLEYBOT_VERSION}*\n\n` +
                                    `📡 Latência de envio: *${latenciaEnvio} ms* (${classificar(latenciaEnvio)})\n` +
                                    `📥 Atraso desde a mensagem: *${atrasoTexto}*\n` +
                                    `🔌 Estado do socket: *${estadoSocket}*\n` +
                                    `ℹ️ Isso mede a resposta do bot/WhatsApp, não a velocidade total da sua internet.`;
                                if (respostaPing?.key?.id) {
                                    await sock.sendMessage(remoteJid, { text: textoFinal, edit: respostaPing.key });
                                }
                            } catch (erroPing) {
                                console.error('[PING] Falha ao medir latência:', erroPing?.message || erroPing);
                                throw erroPing;
                            }
                            break;
                        }

                        case 'ver':
                        case 'sobre':
                            await sock.sendMessage(remoteJid, { text: `Versão: ArleyBot ${ARLEYBOT_VERSION}\nBuild: ${ARLEYBOT_BUILD_ID}\nBot feito por Arley\nCriado para: Fazer figurinha e diversão!` }, { quoted: m });
                            break;

                        case 'fechar':
                            if (!isGroup) return;
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem fechar o grupo.' }, { quoted: m });
                            }
                            await sock.groupSettingUpdate(remoteJid, 'announcement');
                            await sock.sendMessage(remoteJid, { text: '🔒 Grupo fechado!' }, { quoted: m });
                            break;

                        case 'abrir':
                            if (!isGroup) return;
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem abrir o grupo.' }, { quoted: m });
                            }
                            await sock.groupSettingUpdate(remoteJid, 'not_announcement');
                            await sock.sendMessage(remoteJid, { text: '🔓 Grupo aberto!' }, { quoted: m });
                            break;

                        case 'ngrp':
                            if (!isGroup || !textArgs) return;
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem alterar o nome do grupo.' }, { quoted: m });
                            }
                            await sock.groupUpdateSubject(remoteJid, textArgs);
                            await sock.sendMessage(remoteJid, { text: `✅ Nome alterado para: *${textArgs}*` }, { quoted: m });
                            break;

                        case 'dgrp':
                            if (!isGroup || !textArgs) return;
                            if (!(await isAdminGrupo(remoteJid, cleanSender, souDono))) {
                                return await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem alterar a descrição do grupo.' }, { quoted: m });
                            }
                            await sock.groupUpdateDescription(remoteJid, textArgs);
                            await sock.sendMessage(remoteJid, { text: '✅ Descrição alterada!' }, { quoted: m });
                            break;

                        default: {
                            const sugestaoComando = sugerirComandoParecido(command);
                            const linhaSugestao = sugestaoComando
                                ? `\n\n🤔 Você quis usar um comando parecido? Talvez seja *${prefix}${sugestaoComando}*.\nUse: *${prefix}${sugestaoComando}*`
                                : '';
                            await sock.sendMessage(
                                remoteJid,
                                { text: `❌ Comando não encontrado: *${command}*${linhaSugestao}\n\nDigite *${prefix}menu* para ver os comandos.` },
                                { quoted: m }
                            );
                            break;
                        }
                    }
                } catch (err) {
                    console.error(`Erro ao executar comando ${command}:`, err);
                    await sock.sendMessage(remoteJid, { text: '❌ Ocorreu um erro interno ao executar este comando.' }, { quoted: m }).catch(() => {});
                }
            } catch (errHandler) {
                console.error('❌ Erro no handler de mensagens:', errHandler);
            }
        }
    }

    startBot().catch((erroInicializacao) => {
        console.error('[CONEXÃO] ❌ A inicialização falhou:', erroInicializacao?.message || erroInicializacao);
        agendarReconexao('falha na inicialização', 5000);
    });
}


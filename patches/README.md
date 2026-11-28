# patches/

Patches de `patch-package`, aplicados pelo hook `postinstall` do `package.json`.
O Dockerfile copia este diretório **antes** do `npm ci`, senão o postinstall não
acha os patches e o build sai sem eles — silenciosamente.

## `baileys+7.0.0-rc14.patch`

Restaura o pareamento de aparelho novo (leitura de QR).

**Problema.** Por volta de 28/jul/2026 o WhatsApp acrescentou uma etapa ao fluxo
de registro de companion: depois da leitura do QR ele envia
`<notification type='companion_reg_refresh'>`, pedindo para o cliente aposentar
o material de registro. A Baileys dá ack e descarta. O segredo adv anunciado no
QR continua o antigo, que o servidor já aposentou — o celular lê, reporta falha
ao vincular, e `pair-success` nunca chega. Todo QR seguinte da mesma conexão
nasce condenado, porque carrega o mesmo segredo morto.

Vale para rc13, rc14 e o master da Baileys: **nenhuma versão publicada corrige**.
Reproduzido de forma independente no whatsmeow, ou seja, é mudança de protocolo
do WhatsApp, não bug do Evolution nem da Baileys.

**O que o patch faz.** Trata a notificação: rotaciona o segredo adv, emite
`creds.update` e **re-renderiza o QR que já está na tela sem consumir um ref** —
gastar um ref aqui esvaziaria o pool que o servidor alocou e terminaria o fluxo
com `QR refs attempts ended`. Traz junto uma guarda de uma linha no
`link_code_companion_reg`, que estoura `Boom('Invalid buffer', 400)` quando o nó
vem sem os campos de cripto (fluxo de pairing code, que não usamos — a guarda é
inerte aqui, mas evita um crash se alguém chamar a rota).

Sessão já pareada não é afetada: o handler não rotaciona nada quando `creds.me`
existe, justamente porque re-emitir o segredo quebraria a sessão em vez de
renovar um registro pendente.

**Procedência.** Baileys PR
[#2765](https://github.com/WhiskeySockets/Baileys/pull/2765) (aberta desde
10/ago/2026), empacotada para o Evolution na PR
[#2727](https://github.com/evolution-foundation/evolution-api/pull/2727).
Ambas ainda não mergeadas.

**Quando remover.** Assim que a Baileys publicar uma versão com a #2765. O nome
do arquivo está preso à versão (`baileys+7.0.0-rc14`), então o próximo bump da
Baileys faz o `patch-package` falhar em voz alta em vez de aplicar algo errado —
é o sinal para reavaliar, não para forçar.

### Evento `pdo.no-response` (detector de saúde)

Além do pareamento, o patch faz a `messages-recv.js` emitir `pdo.no-response` quando um pedido de reenvio ao
celular (PDO) fica 8 s sem resposta. A Baileys só registra isso em `debug` (some com `LOG_BAILEYS=error`); o
`src/utils/instanceHealth.ts` conta o evento para o alerta `celular_offline` (5 em 30 min). O teste
`tests/unit/baileys-patch.test.ts` confere que o patch está aplicado.

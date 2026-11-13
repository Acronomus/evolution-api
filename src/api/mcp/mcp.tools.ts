import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod4';

import { EvolutionClient, EvolutionError } from './mcp.client';
import { redact, redactText } from './mcp.redact';

export const MCP_VERSION = '0.3.0';

export interface McpToolsOptions {
  /** Só ferramentas de leitura. */
  readOnly: boolean;
  /** Instâncias que nunca são desconectadas nem apagadas pelo MCP. */
  protectedInstances: string[];
  /** Mostra tokens e senhas nas respostas. */
  showSecrets: boolean;
  /** A chave de quem chama é a global (vê e cria instâncias); senão é o token de uma instância. */
  globalKey: boolean;
}

export const EVENTS = [
  'APPLICATION_STARTUP',
  'QRCODE_UPDATED',
  'MESSAGES_SET',
  'MESSAGES_UPSERT',
  'MESSAGES_EDITED',
  'MESSAGES_UPDATE',
  'MESSAGES_DELETE',
  'SEND_MESSAGE',
  'SEND_MESSAGE_UPDATE',
  'CONTACTS_SET',
  'CONTACTS_UPSERT',
  'CONTACTS_UPDATE',
  'PRESENCE_UPDATE',
  'CHATS_SET',
  'CHATS_UPSERT',
  'CHATS_UPDATE',
  'CHATS_DELETE',
  'GROUPS_UPSERT',
  'GROUP_UPDATE',
  'GROUP_PARTICIPANTS_UPDATE',
  'CONNECTION_UPDATE',
  'LABELS_EDIT',
  'LABELS_ASSOCIATION',
  'CALL',
  'TYPEBOT_START',
  'TYPEBOT_CHANGE_STATUS',
  'REMOVE_INSTANCE',
  'LOGOUT_INSTANCE',
  'INSTANCE_CREATE',
  'INSTANCE_DELETE',
  'STATUS_INSTANCE',
] as const;

/** Integrações de evento que usam o mesmo formato `{ <tipo>: { enabled, events } }`. */
export const EVENT_TRANSPORTS = ['websocket', 'rabbitmq', 'nats', 'sqs', 'kafka'] as const;

const PRIVACY_KEYS = ['readreceipts', 'profile', 'status', 'online', 'last', 'groupadd'] as const;

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

const instanceName = z.string().min(1).describe('Nome da instância na Evolution');
const visibility = z.enum(['all', 'contacts', 'contact_blacklist', 'none']);

const settingsShape = {
  rejectCall: z.boolean().optional().describe('Recusar chamadas automaticamente'),
  msgCall: z.string().optional().describe('Mensagem enviada ao recusar uma chamada'),
  groupsIgnore: z.boolean().optional().describe('Ignorar mensagens de grupos'),
  alwaysOnline: z.boolean().optional().describe('Manter a instância sempre online'),
  readMessages: z.boolean().optional().describe('Marcar mensagens recebidas como lidas'),
  readStatus: z.boolean().optional().describe('Marcar status como vistos'),
  syncFullHistory: z.boolean().optional().describe('Sincronizar o histórico completo ao conectar'),
  wavoipToken: z.string().optional().describe('Token do Wavoip (chamadas)'),
};

const webhookShape = {
  url: z.string().url().describe('URL que recebe os eventos'),
  enabled: z.boolean().optional().describe('Padrão: true'),
  byEvents: z.boolean().optional().describe('Acrescentar o nome do evento na URL'),
  base64: z.boolean().optional().describe('Mandar mídia em base64 no payload'),
  headers: z.record(z.string(), z.string()).optional().describe('Headers extras enviados ao webhook'),
  events: z.array(z.enum(EVENTS)).optional().describe('Eventos enviados (vazio = todos)'),
};

const enc = encodeURIComponent;

export function createMcpServer(client: EvolutionClient, config: McpToolsOptions): McpServer {
  const server = new McpServer({ name: 'evolution-api', version: MCP_VERSION });
  const show = (data: unknown) => (config.showSecrets ? data : redact(data));
  const json = (data: unknown): Content => ({ type: 'text', text: JSON.stringify(show(data), null, 2) });

  /** Erros viram resultado `isError` com a mensagem da Evolution, em vez de derrubar a chamada. */
  const run =
    <A>(fn: (args: A) => Promise<ToolResult | unknown>) =>
    async (args: A): Promise<ToolResult> => {
      try {
        const out = await fn(args);
        if (out && typeof out === 'object' && 'content' in (out as object)) return out as ToolResult;
        return { content: [json(out)] };
      } catch (err) {
        const msg =
          err instanceof EvolutionError
            ? err.message + (err.body && typeof err.body === 'object' ? `\n${JSON.stringify(show(err.body))}` : '')
            : err instanceof Error
              ? err.message
              : String(err);
        return { isError: true, content: [{ type: 'text', text: msg }] };
      }
    };

  /** Resposta de `connect` (e do `create` com qrcode) com o QR como imagem. */
  const withQr = (data: any, qr: any): ToolResult => {
    const content: Content[] = [json(data)];
    const b64: unknown = qr?.base64;
    if (typeof b64 === 'string' && b64.length > 0) {
      const m = /^data:(image\/[\w+.-]+);base64,(.*)$/s.exec(b64);
      content.push({ type: 'image', mimeType: m?.[1] ?? 'image/png', data: m?.[2] ?? b64 });
    }
    if (qr?.pairingCode) content.push({ type: 'text', text: `Código de pareamento: ${qr.pairingCode}` });
    return { content };
  };

  const fetchInstance = async (name: string): Promise<any> => {
    const list = await client.request<any[]>('GET', `/instance/fetchInstances?instanceName=${enc(name)}`);
    const found = Array.isArray(list)
      ? (list.find((i) => i?.name === name || i?.instanceName === name) ?? list[0])
      : null;
    if (!found) throw new Error(`Instância "${name}" não encontrada`);
    return found;
  };

  const ownNumber = async (name: string): Promise<string> => {
    const inst = await fetchInstance(name);
    const jid: string | undefined = inst.ownerJid ?? inst.owner;
    if (!jid) throw new Error(`A instância "${name}" não está conectada (sem ownerJid); informe o número`);
    return jid.split('@')[0].split(':')[0];
  };

  const ro = { readOnlyHint: true, openWorldHint: true } as const;
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
  const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

  // ───────────────────────────── leitura ─────────────────────────────

  server.registerTool(
    'evolution_server_info',
    {
      title: 'Informações do servidor Evolution',
      description: 'Versão da Evolution, nome do cliente e versão do WhatsApp Web. Serve para testar a conexão.',
      annotations: ro,
    },
    run(() => client.request('GET', '/')),
  );

  server.registerTool(
    'evolution_instance_list',
    {
      title: 'Listar instâncias',
      description:
        'Lista as instâncias com status de conexão, número, perfil, integração, configurações e contadores. ' +
        'Filtre por nome ou id; sem filtro traz todas.',
      inputSchema: z.object({
        instanceName: z.string().optional().describe('Filtra por nome exato'),
        instanceId: z.string().optional().describe('Filtra pelo id da instância'),
      }),
      annotations: ro,
    },
    run(({ instanceName, instanceId }) => {
      const qs = new URLSearchParams();
      if (instanceName) qs.set('instanceName', instanceName);
      if (instanceId) qs.set('instanceId', instanceId);
      const q = qs.toString();
      return client.request('GET', `/instance/fetchInstances${q ? `?${q}` : ''}`);
    }),
  );

  server.registerTool(
    'evolution_instance_connection_state',
    {
      title: 'Estado da conexão',
      description: 'Estado da conexão com o WhatsApp: open (conectada), connecting ou close.',
      inputSchema: z.object({ instanceName }),
      annotations: ro,
    },
    run(({ instanceName }) => client.request('GET', `/instance/connectionState/${enc(instanceName)}`)),
  );

  server.registerTool(
    'evolution_instance_settings_get',
    {
      title: 'Ler configurações da instância',
      description:
        'Configurações de comportamento: recusar chamadas, ignorar grupos, sempre online, ler mensagens etc.',
      inputSchema: z.object({ instanceName }),
      annotations: ro,
    },
    run(({ instanceName }) => client.request('GET', `/settings/find/${enc(instanceName)}`)),
  );

  server.registerTool(
    'evolution_instance_proxy_get',
    {
      title: 'Ler proxy da instância',
      description: 'Proxy configurado na instância (a senha sai mascarada).',
      inputSchema: z.object({ instanceName }),
      annotations: ro,
    },
    run(({ instanceName }) => client.request('GET', `/proxy/find/${enc(instanceName)}`)),
  );

  server.registerTool(
    'evolution_instance_webhook_get',
    {
      title: 'Ler webhook da instância',
      description: 'URL, eventos e opções do webhook da instância.',
      inputSchema: z.object({ instanceName }),
      annotations: ro,
    },
    run(({ instanceName }) => client.request('GET', `/webhook/find/${enc(instanceName)}`)),
  );

  server.registerTool(
    'evolution_instance_events_get',
    {
      title: 'Ler integração de eventos',
      description: 'Configuração de uma integração de eventos da instância (websocket, rabbitmq, nats, sqs, kafka).',
      inputSchema: z.object({ instanceName, transport: z.enum(EVENT_TRANSPORTS) }),
      annotations: ro,
    },
    run(({ instanceName, transport }) => client.request('GET', `/${transport}/find/${enc(instanceName)}`)),
  );

  server.registerTool(
    'evolution_instance_profile_get',
    {
      title: 'Ler perfil',
      description:
        'Perfil do WhatsApp (nome, foto, recado, se é business). Sem `number`, traz o perfil da própria instância. ' +
        'A instância precisa estar conectada.',
      inputSchema: z.object({
        instanceName,
        number: z.string().optional().describe('Número com DDI (ex.: 5511999999999); vazio = a própria instância'),
      }),
      annotations: ro,
    },
    run(({ instanceName, number }) =>
      client.request('POST', `/chat/fetchProfile/${enc(instanceName)}`, number ? { number } : {}),
    ),
  );

  server.registerTool(
    'evolution_instance_business_profile_get',
    {
      title: 'Ler perfil comercial',
      description:
        'Perfil comercial (descrição, categoria, e-mail, site, endereço). Sem `number`, usa o número da própria instância.',
      inputSchema: z.object({ instanceName, number: z.string().optional() }),
      annotations: ro,
    },
    run(async ({ instanceName, number }) =>
      client.request('POST', `/chat/fetchBusinessProfile/${enc(instanceName)}`, {
        number: number ?? (await ownNumber(instanceName)),
      }),
    ),
  );

  server.registerTool(
    'evolution_instance_privacy_get',
    {
      title: 'Ler privacidade',
      description:
        'Configurações de privacidade da conta (visto por último, foto, recado, confirmação de leitura, grupos).',
      inputSchema: z.object({ instanceName }),
      annotations: ro,
    },
    run(({ instanceName }) => client.request('GET', `/chat/fetchPrivacySettings/${enc(instanceName)}`)),
  );

  if (config.globalKey) {
    server.registerTool(
      'evolution_logs',
      {
        title: 'Logs do servidor',
        description:
          'Últimas linhas do stdout/stderr do servidor, como `docker logs --tail N --since X | grep`: ' +
          'Logger da Evolution, baileys e stack traces, sem cores. Só desde o último restart e só desta réplica. ' +
          'Para achar um problema, comece com level=ERROR,WARN ou grep e aumente o tail se precisar.',
        inputSchema: z.object({
          tail: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('Últimas N linhas depois dos filtros (padrão 200, sem máximo)'),
          since: z.string().optional().describe('ISO (2026-11-13T10:00:00Z) ou relativo: 30s, 10m, 2h, 1d'),
          grep: z.string().optional().describe('Texto procurado (sem diferenciar maiúsculas)'),
          regex: z.boolean().optional().describe('Trata o grep como expressão regular'),
          instanceName: z.string().optional().describe('Só linhas da instância ([nome] no log)'),
          level: z
            .array(z.enum(['ERROR', 'WARN', 'INFO', 'LOG', 'DEBUG', 'VERBOSE', 'DARK']))
            .optional()
            .describe('Níveis do Logger; linhas da baileys e stack traces não têm nível'),
          stream: z.enum(['stdout', 'stderr']).optional(),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      run(async ({ tail, since, grep, regex, instanceName, level, stream }) => {
        const qs = new URLSearchParams();
        if (tail) qs.set('tail', String(tail));
        if (since) qs.set('since', since);
        if (grep) qs.set('grep', grep);
        if (regex) qs.set('regex', 'true');
        if (instanceName) qs.set('instance', instanceName);
        if (level?.length) qs.set('level', level.join(','));
        if (stream) qs.set('stream', stream);
        const q = qs.toString();
        const r = await client.request<{
          lines: { time: string; stream: string; text: string }[];
          matched: number;
          buffered: number;
          oldest: string | null;
        }>('GET', `/logs${q ? `?${q}` : ''}`);
        const head =
          `${r.lines.length} de ${r.matched} linha(s) encontradas; buffer com ${r.buffered}` +
          (r.oldest ? ` desde ${r.oldest}` : ' (vazio)');
        const body = r.lines.map((l) => `${l.time}${l.stream === 'stderr' ? ' [stderr]' : ''} ${l.text}`).join('\n');
        const text = body ? `${head}\n\n${body}` : head;
        return { content: [{ type: 'text', text: config.showSecrets ? text : redactText(text) }] };
      }),
    );
  }

  if (config.readOnly) return server;

  // ───────────────────────────── escrita ─────────────────────────────

  if (config.globalKey)
    server.registerTool(
      'evolution_instance_create',
      {
        title: 'Criar instância',
        description:
          'Cria uma instância. Com `qrcode: true` (padrão) já inicia a conexão e devolve o QR code como imagem; ' +
          'com `number`, devolve também o código de pareamento. Configurações, proxy e webhook podem vir na criação. ' +
          'Sem `token`, a Evolution gera um (mascarado na resposta, a menos que MCP_SHOW_SECRETS=true).',
        inputSchema: z.object({
          instanceName,
          integration: z
            .enum(['WHATSAPP-BAILEYS', 'WHATSAPP-BUSINESS', 'EVOLUTION'])
            .default('WHATSAPP-BAILEYS')
            .describe('Canal: Baileys (WhatsApp Web), API oficial da Meta ou Evolution'),
          qrcode: z.boolean().default(true).describe('Iniciar a conexão e devolver o QR (só Baileys)'),
          number: z
            .string()
            .optional()
            .describe('Número com DDI; obrigatório na WHATSAPP-BUSINESS, gera pairing code na Baileys'),
          token: z.string().optional().describe('Token (apikey) da instância; vazio = gerado'),
          businessId: z.string().optional().describe('Business ID (WHATSAPP-BUSINESS)'),
          ...settingsShape,
          proxy: z
            .object({
              host: z.string(),
              port: z.string(),
              protocol: z.enum(['http', 'https', 'socks4', 'socks5']),
              username: z.string().optional(),
              password: z.string().optional(),
            })
            .optional(),
          webhook: z.object(webhookShape).optional(),
        }),
        annotations: rw,
      },
      run(async ({ proxy, webhook, ...rest }) => {
        const body: Record<string, unknown> = { ...rest };
        if (proxy) {
          body.proxyHost = proxy.host;
          body.proxyPort = proxy.port;
          body.proxyProtocol = proxy.protocol;
          body.proxyUsername = proxy.username;
          body.proxyPassword = proxy.password;
        }
        if (webhook) body.webhook = { enabled: true, ...webhook };
        const res: any = await client.request('POST', '/instance/create', body);
        return withQr(res, res?.qrcode);
      }),
    );

  server.registerTool(
    'evolution_instance_connect',
    {
      title: 'Conectar instância (QR code)',
      description:
        'Inicia ou retoma a conexão com o WhatsApp e devolve o QR code como imagem para escanear. ' +
        'Com `number`, devolve o código de pareamento para digitar no celular. Se já estiver conectada, só devolve o estado.',
      inputSchema: z.object({
        instanceName,
        number: z.string().optional().describe('Número com DDI para gerar código de pareamento'),
      }),
      annotations: rw,
    },
    run(async ({ instanceName, number }) => {
      const q = number ? `?number=${enc(number)}` : '';
      const res: any = await client.request('GET', `/instance/connect/${enc(instanceName)}${q}`);
      return withQr(res, res);
    }),
  );

  server.registerTool(
    'evolution_instance_restart',
    {
      title: 'Reiniciar instância',
      description: 'Reinicia a sessão da instância (reconecta sem desparear o celular).',
      inputSchema: z.object({ instanceName }),
      annotations: { ...rw, idempotentHint: true },
    },
    run(({ instanceName }) => client.request('POST', `/instance/restart/${enc(instanceName)}`)),
  );

  server.registerTool(
    'evolution_instance_set_presence',
    {
      title: 'Definir presença',
      description: 'Deixa a instância disponível (online) ou indisponível.',
      inputSchema: z.object({ instanceName, presence: z.enum(['available', 'unavailable']) }),
      annotations: { ...rw, idempotentHint: true },
    },
    run(({ instanceName, presence }) =>
      client.request('POST', `/instance/setPresence/${enc(instanceName)}`, { presence }),
    ),
  );

  server.registerTool(
    'evolution_instance_settings_update',
    {
      title: 'Editar configurações da instância',
      description:
        'Altera as configurações de comportamento. Só os campos informados mudam; os demais são lidos da instância e mantidos.',
      inputSchema: z.object({ instanceName, ...settingsShape }),
      annotations: { ...rw, idempotentHint: true },
    },
    run(async ({ instanceName, ...patch }) => {
      const current: any = (await client.request('GET', `/settings/find/${enc(instanceName)}`)) ?? {};
      const body = {
        rejectCall: current.rejectCall ?? false,
        msgCall: current.msgCall ?? '',
        groupsIgnore: current.groupsIgnore ?? false,
        alwaysOnline: current.alwaysOnline ?? false,
        readMessages: current.readMessages ?? false,
        readStatus: current.readStatus ?? false,
        syncFullHistory: current.syncFullHistory ?? false,
        ...(current.wavoipToken ? { wavoipToken: current.wavoipToken } : {}),
        ...stripUndefined(patch),
      };
      return client.request('POST', `/settings/set/${enc(instanceName)}`, body);
    }),
  );

  server.registerTool(
    'evolution_instance_proxy_set',
    {
      title: 'Configurar proxy da instância',
      description:
        'Liga, altera ou desliga o proxy. Para desligar, mande só `enabled: false` (a Evolution apaga host, porta e ' +
        'credenciais). Ao alterar, os campos não informados vêm do proxy atual. A Evolution testa o proxy antes de salvar.',
      inputSchema: z.object({
        instanceName,
        enabled: z.boolean(),
        host: z.string().optional(),
        port: z.string().optional(),
        protocol: z.enum(['http', 'https', 'socks4', 'socks5']).optional(),
        username: z.string().optional(),
        password: z.string().optional(),
      }),
      annotations: { ...rw, idempotentHint: true },
    },
    run(async ({ instanceName, ...patch }) => {
      const path = `/proxy/set/${enc(instanceName)}`;
      // Desligado, a Evolution zera os campos; o schema dela só exige que venham preenchidos.
      if (!patch.enabled)
        return client.request('POST', path, { enabled: false, host: '-', port: '-', protocol: 'http' });

      const current: any = (await client.request('GET', `/proxy/find/${enc(instanceName)}`)) ?? {};
      const body: Record<string, unknown> = {
        host: current.host || undefined,
        port: current.port || undefined,
        protocol: current.protocol || undefined,
        username: current.username || undefined,
        password: current.password || undefined,
        ...stripUndefined(patch),
      };
      for (const k of ['host', 'port', 'protocol'] as const) {
        if (!body[k]) throw new Error(`Para ligar o proxy informe "${k}"`);
      }
      return client.request('POST', path, stripUndefined(body));
    }),
  );

  server.registerTool(
    'evolution_instance_webhook_set',
    {
      title: 'Configurar webhook da instância',
      description:
        'Cria ou altera o webhook. Só os campos informados mudam; o resto é mantido do webhook atual. ' +
        'Com `enabled: true` e lista de eventos vazia, a Evolution envia todos os eventos.',
      inputSchema: z.object({ instanceName, ...webhookShape, url: webhookShape.url.optional() }),
      annotations: { ...rw, idempotentHint: true },
    },
    run(async ({ instanceName, ...patch }) => {
      const current: any = (await client.request('GET', `/webhook/find/${enc(instanceName)}`)) ?? {};
      const webhook = {
        enabled: current.enabled ?? true,
        url: current.url,
        headers: current.headers ?? undefined,
        byEvents: current.webhookByEvents ?? false,
        base64: current.webhookBase64 ?? false,
        events: Array.isArray(current.events) ? current.events : [],
        ...stripUndefined(patch),
      };
      if (!webhook.url) throw new Error('A instância não tem webhook; informe "url"');
      return client.request('POST', `/webhook/set/${enc(instanceName)}`, { webhook: stripUndefined(webhook) });
    }),
  );

  server.registerTool(
    'evolution_instance_events_set',
    {
      title: 'Configurar integração de eventos',
      description:
        'Liga ou desliga uma integração de eventos (websocket, rabbitmq, nats, sqs, kafka) e escolhe os eventos. ' +
        'Ligada com lista vazia = todos os eventos.',
      inputSchema: z.object({
        instanceName,
        transport: z.enum(EVENT_TRANSPORTS),
        enabled: z.boolean(),
        events: z.array(z.enum(EVENTS)).optional(),
      }),
      annotations: { ...rw, idempotentHint: true },
    },
    run(({ instanceName, transport, enabled, events }) =>
      client.request('POST', `/${transport}/set/${enc(instanceName)}`, {
        [transport]: { enabled, events: events ?? [] },
      }),
    ),
  );

  server.registerTool(
    'evolution_instance_profile_name_update',
    {
      title: 'Alterar nome do perfil',
      description: 'Muda o nome exibido do WhatsApp da instância. A instância precisa estar conectada.',
      inputSchema: z.object({ instanceName, name: z.string().min(1).max(25) }),
      annotations: { ...rw, idempotentHint: true },
    },
    run(({ instanceName, name }) => client.request('POST', `/chat/updateProfileName/${enc(instanceName)}`, { name })),
  );

  server.registerTool(
    'evolution_instance_profile_status_update',
    {
      title: 'Alterar recado do perfil',
      description: 'Muda o recado ("sobre") do WhatsApp da instância.',
      inputSchema: z.object({ instanceName, status: z.string().min(1).max(139) }),
      annotations: { ...rw, idempotentHint: true },
    },
    run(({ instanceName, status }) =>
      client.request('POST', `/chat/updateProfileStatus/${enc(instanceName)}`, { status }),
    ),
  );

  server.registerTool(
    'evolution_instance_profile_picture_update',
    {
      title: 'Alterar foto do perfil',
      description: 'Troca a foto do perfil da instância por uma imagem (URL pública ou base64).',
      inputSchema: z.object({ instanceName, picture: z.string().min(1).describe('URL da imagem ou base64') }),
      annotations: { ...rw, idempotentHint: true },
    },
    run(({ instanceName, picture }) =>
      client.request('POST', `/chat/updateProfilePicture/${enc(instanceName)}`, { picture }),
    ),
  );

  server.registerTool(
    'evolution_instance_profile_picture_remove',
    {
      title: 'Remover foto do perfil',
      description: 'Remove a foto do perfil da instância.',
      inputSchema: z.object({ instanceName }),
      annotations: { ...rw, destructiveHint: true, idempotentHint: true },
    },
    run(({ instanceName }) => client.request('DELETE', `/chat/removeProfilePicture/${enc(instanceName)}`)),
  );

  server.registerTool(
    'evolution_instance_privacy_update',
    {
      title: 'Alterar privacidade',
      description: 'Altera a privacidade da conta. Só os campos informados mudam; os demais são lidos e mantidos.',
      inputSchema: z.object({
        instanceName,
        readreceipts: z.enum(['all', 'none']).optional().describe('Confirmação de leitura'),
        profile: visibility.optional().describe('Quem vê a foto'),
        status: visibility.optional().describe('Quem vê o recado'),
        online: z.enum(['all', 'match_last_seen']).optional().describe('Quem vê quando está online'),
        last: visibility.optional().describe('Quem vê o visto por último'),
        groupadd: visibility.optional().describe('Quem pode adicionar em grupos'),
      }),
      annotations: { ...rw, idempotentHint: true },
    },
    run(async ({ instanceName, ...patch }) => {
      const current: any = (await client.request('GET', `/chat/fetchPrivacySettings/${enc(instanceName)}`)) ?? {};
      const body: Record<string, unknown> = {};
      for (const k of PRIVACY_KEYS) body[k] = patch[k] ?? current[k];
      const missing = PRIVACY_KEYS.filter((k) => !body[k]);
      if (missing.length) throw new Error(`Não foi possível ler a privacidade atual; informe: ${missing.join(', ')}`);
      return client.request('POST', `/chat/updatePrivacySettings/${enc(instanceName)}`, body);
    }),
  );

  // ─────────────────────────── destrutivas ───────────────────────────

  const guard = (name: string, confirm: string) => {
    if (config.protectedInstances.includes(name)) {
      throw new Error(
        `A instância "${name}" está protegida (MCP_PROTECTED_INSTANCES); faça isso pelo manager da Evolution.`,
      );
    }
    if (confirm !== name) throw new Error(`Confirmação não confere: repita o nome exato da instância em "confirm".`);
  };

  const confirm = z.string().describe('Repita o nome exato da instância para confirmar');

  server.registerTool(
    'evolution_instance_logout',
    {
      title: 'Desconectar instância',
      description:
        'Desconecta o WhatsApp (desfaz o pareamento com o celular). A instância continua existindo e pode ser ' +
        'conectada de novo com evolution_instance_connect. Exige `confirm` igual ao nome da instância.',
      inputSchema: z.object({ instanceName, confirm }),
      annotations: destructive,
    },
    run(({ instanceName, confirm }) => {
      guard(instanceName, confirm);
      return client.request('DELETE', `/instance/logout/${enc(instanceName)}`);
    }),
  );

  server.registerTool(
    'evolution_instance_delete',
    {
      title: 'Excluir instância',
      description:
        'Apaga a instância e os dados dela na Evolution (sessão, configurações, webhook, mensagens guardadas). ' +
        'Não tem volta. Exige `confirm` igual ao nome da instância.',
      inputSchema: z.object({ instanceName, confirm }),
      annotations: destructive,
    },
    run(({ instanceName, confirm }) => {
      guard(instanceName, confirm);
      return client.request('DELETE', `/instance/delete/${enc(instanceName)}`);
    }),
  );

  return server;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

# evolution-mcp

MCP interno da Acronomus para gerenciar **instâncias** da Evolution API: criar, conectar (QR code
ou código de pareamento), configurar, editar perfil e privacidade, desconectar e excluir.
Servidor stdio que chama a API REST da Evolution com a chave global; não entra na imagem Docker
da Evolution nem mexe no código dela.

## Configuração

| Variável | Obrigatória | O que faz |
|---|---|---|
| `EVOLUTION_URL` | sim | URL base da Evolution (ex.: `https://evo.exemplo.com`) |
| `EVOLUTION_API_KEY` | sim | Chave **global** (`AUTHENTICATION_API_KEY`) |
| `EVOLUTION_MCP_MODE` | não | `write` (padrão) ou `read` (só ferramentas de leitura) |
| `EVOLUTION_MCP_PROTECTED_INSTANCES` | não | Instâncias que o MCP nunca desconecta nem apaga, separadas por vírgula |
| `EVOLUTION_MCP_SHOW_SECRETS` | não | `true` para mostrar tokens e senhas nas respostas (padrão: mascarados) |
| `EVOLUTION_MCP_TIMEOUT_MS` | não | Timeout por chamada (padrão 30000) |

## Instalar no Claude Code

```bash
cd mcp && npm ci && npm run build
```

```bash
claude mcp add evolution --scope user \
  -e EVOLUTION_URL=https://evo.exemplo.com \
  -e EVOLUTION_API_KEY=... \
  -e EVOLUTION_MCP_PROTECTED_INSTANCES=instancia-de-producao \
  -- node /caminho/para/evolution-api/mcp/dist/index.js
```

A chave global controla **todas** as instâncias do servidor. Para só olhar, use
`EVOLUTION_MCP_MODE=read`. Liste em `EVOLUTION_MCP_PROTECTED_INSTANCES` as instâncias que
atendem clientes.

## Ferramentas

**Leitura:** `evolution_server_info`, `evolution_instance_list`, `evolution_instance_connection_state`,
`evolution_instance_settings_get`, `evolution_instance_proxy_get`, `evolution_instance_webhook_get`,
`evolution_instance_events_get`, `evolution_instance_profile_get`, `evolution_instance_business_profile_get`,
`evolution_instance_privacy_get`.

**Escrita:** `evolution_instance_create`, `evolution_instance_connect`, `evolution_instance_restart`,
`evolution_instance_set_presence`, `evolution_instance_settings_update`, `evolution_instance_proxy_set`,
`evolution_instance_webhook_set`, `evolution_instance_events_set` (websocket, rabbitmq, nats, sqs, kafka),
`evolution_instance_profile_name_update`, `evolution_instance_profile_status_update`,
`evolution_instance_profile_picture_update`, `evolution_instance_profile_picture_remove`,
`evolution_instance_privacy_update`.

**Destrutivas** (exigem `confirm` igual ao nome da instância e respeitam as protegidas):
`evolution_instance_logout`, `evolution_instance_delete`.

As edições (`settings_update`, `webhook_set`, `proxy_set`, `privacy_update`) são parciais: leem a
configuração atual e mudam só os campos informados, porque os endpoints da Evolution exigem o objeto
inteiro.

## Testes

```bash
npm run typecheck && npm test && npm run build
```

Os testes ligam um cliente MCP real ao servidor em memória, com a Evolution trocada por um `fetch`
falso. Não usam rede. As respostas foram montadas a partir dos controllers do fork. O job `mcp`
do CI roda os mesmos passos.

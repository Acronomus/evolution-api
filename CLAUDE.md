# CLAUDE.md

## Build próprio da Acronomus (leia primeiro)

Este fork tem dois papéis. O `main` espelha o upstream (EvolutionAPI) e não é mexido aqui. O branch
**`2.3.7-baileys-rc14`** é o build que roda em produção: 2.3.7 do upstream + baileys rc14 + as
correções da Acronomus (os commits depois de `2.3.7`) + `patches/` (patch-package). Todo trabalho
vai em PR **para `2.3.7-baileys-rc14`**, nunca para o `main` nem direto no branch: o push nele
publica a imagem no GHCR (`build-image.yml`). Merge só com o Miguel.

### Testes: toda mudança vem com teste

O CI (`.github/workflows/ci.yml`) roda no runner próprio em todo PR e push para
`2.3.7-baileys-rc14`. O security-bot só faz merge automático com ele verde; ninguém mais bloqueia
(o plano da org não tem proteção de branch). Os mesmos passos rodam localmente:

```bash
DATABASE_PROVIDER=postgresql npm run db:generate
npm run lint:check
npm run typecheck          # app e testes
npm run test:unit          # Vitest, sem banco nem rede
npm run test:integration   # Postgres e Redis reais em containers (precisa de Docker)
npm run test:routes        # toda rota do app tem teste de integração
npm run build && docker build -t evolution-api-local .
```

Vitest, não Jest: a baileys 7 é ESM puro. Pelo mesmo motivo o `tsx` não carrega a baileys
(`npm start` e `npm run dev:server` quebram com `ERR_PACKAGE_PATH_NOT_EXPORTED`); use
`npm run build && npm run start:prod`.

Regras:

- **Rota nova ou alterada → teste em `tests/integration/`** com `api()` e `GLOBAL_KEY`
  (`helpers/app.ts`) e as instâncias de `helpers/instances.ts`. Cubra o caminho feliz, a
  autenticação (sem chave, token de outra instância) e o isolamento entre instâncias.
- **`tests/integration/routes-pending.txt` só diminui.** Rota nova não entra nela: escreva o teste.
  Ao cobrir uma rota da lista, tire a linha (o `test:routes` avisa).
- **Mudança de comportamento → atualize o teste que descreve o comportamento antigo.** Não apague
  nem pule (`.skip`) teste que falhou sem entender por quê. `it.fails` marca bug conhecido: quando
  o bug for corrigido o teste falha, e aí ele vira `it`.
- **A baileys nunca conecta nos testes.** O `makeWASocket` é trocado por `helpers/fakeBaileys.ts`,
  que usa o event buffer real da baileys; o teste dirige o socket (`open()`, `end()`,
  `ev.emit('messages.upsert', ...)`) e confere as chamadas (`sendMessage`, `readMessages`...).
- **Nada de rede nos testes.** O nock recusa HTTP/fetch para fora e o setup bloqueia sockets TCP
  para fora da máquina. Provedor externo entra com resposta montada no teste, marcada como não
  confirmada; não grave resposta real de provedor sem o Miguel aprovar (e anonimizar).
- **Nada de `.env` real nos testes**: `tests/setup.ts` desliga o `dotenv` e `tests/testEnv.ts` fixa
  as variáveis. Variável nova no `env.config.ts` que precise de valor nos testes entra lá.
- **Mudou a correção de um commit do build próprio? O teste dela está em `tests/`** (o comentário no
  topo de cada arquivo cita o commit).

### Banco e migrations

- O deploy roda `npm run db:deploy` (Docker/scripts/deploy_database.sh): copia
  `prisma/postgresql-migrations` para `prisma/migrations` e aplica. Os testes criam o banco do zero
  do mesmo jeito.
- Mudança de schema vira migration em `prisma/postgresql-migrations` (`npm run db:migrate:dev`);
  **nunca `prisma db push`**. `tests/integration/schema.test.ts` falha se
  `prisma/postgresql-schema.prisma` e as migrations divergirem.
- Só o Postgres é testado. `mysql-*` e `psql_bouncer-schema.prisma` vêm do upstream e não são
  usados em produção.

### Dependências

- `patches/baileys+<versão>.patch` é aplicado no `postinstall`. Subir a baileys faz o
  `patch-package` falhar de propósito (e o `tests/unit/baileys-patch.test.ts` também): reavalie o
  patch antes de forçar. Veja `patches/README.md`.
- Lockfile: regere com `npm install --package-lock-only` e confira com `npm ci`; `npm install` com
  `node_modules` presente perde os binários opcionais de outras plataformas.

---

This file provides comprehensive guidance to Claude AI when working with the Evolution API codebase.

## Project Overview

**Evolution API** is a powerful, production-ready REST API for WhatsApp communication that supports multiple WhatsApp providers:
- **Baileys** (WhatsApp Web) - Open-source WhatsApp Web client
- **Meta Business API** - Official WhatsApp Business API
- **Evolution API** - Custom WhatsApp integration

Built with **Node.js 20+**, **TypeScript 5+**, and **Express.js**, it provides extensive integrations with chatbots, CRM systems, and messaging platforms in a **multi-tenant architecture**.

## Common Development Commands

### Build and Run
```bash
# Development
npm run dev:server    # Run in development with hot reload (tsx watch)

# Production
npm run build        # TypeScript check + tsup build
npm run start:prod   # Run production build

# Direct execution
npm start           # Run with tsx
```

### Code Quality
```bash
npm run lint        # ESLint with auto-fix
npm run lint:check  # ESLint check only
npm run commit      # Interactive commit with commitizen
```

### Database Management
```bash
# Set database provider first
export DATABASE_PROVIDER=postgresql  # or mysql

# Generate Prisma client (automatically uses DATABASE_PROVIDER env)
npm run db:generate

# Deploy migrations (production)
npm run db:deploy      # Unix/Mac
npm run db:deploy:win  # Windows

# Development migrations (with sync to provider folder)
npm run db:migrate:dev      # Unix/Mac
npm run db:migrate:dev:win  # Windows

# Open Prisma Studio
npm run db:studio

# Development migrations
npm run db:migrate:dev      # Unix/Mac
npm run db:migrate:dev:win  # Windows
```

### Testing
```bash
npm test    # Vitest: unit + integration (see the top of this file)
```

## Architecture Overview

### Core Structure
- **Multi-tenant SaaS**: Complete instance isolation with per-tenant authentication
- **Multi-provider database**: PostgreSQL and MySQL via Prisma ORM with provider-specific schemas and migrations
- **WhatsApp integrations**: Baileys, Meta Business API, and Evolution API with unified interface
- **Event-driven architecture**: EventEmitter2 for internal events + WebSocket, RabbitMQ, SQS, NATS, Pusher for external events
- **Microservices pattern**: Modular integrations for chatbots, storage, and external services

### Directory Layout
```
src/
├── api/
│   ├── controllers/     # HTTP route handlers (thin layer)
│   ├── services/        # Business logic (core functionality)
│   ├── repository/      # Data access layer (Prisma)
│   ├── dto/            # Data Transfer Objects (simple classes)
│   ├── guards/         # Authentication/authorization middleware
│   ├── integrations/   # External service integrations
│   │   ├── channel/    # WhatsApp providers (Baileys, Business API, Evolution)
│   │   ├── chatbot/    # AI/Bot integrations (OpenAI, Dify, Typebot, Chatwoot)
│   │   ├── event/      # Event systems (WebSocket, RabbitMQ, SQS, NATS, Pusher)
│   │   └── storage/    # File storage (S3, MinIO)
│   ├── routes/         # Express route definitions (RouterBroker pattern)
│   └── types/          # TypeScript type definitions
├── config/             # Environment and app configuration
├── cache/             # Redis and local cache implementations
├── exceptions/        # Custom HTTP exception classes
├── utils/            # Shared utilities and helpers
└── validate/         # JSONSchema7 validation schemas
```

### Key Integration Points

**Channel Integrations** (`src/api/integrations/channel/`):
- **Baileys**: WhatsApp Web client with QR code authentication
- **Business API**: Official Meta WhatsApp Business API
- **Evolution API**: Custom WhatsApp integration
- Connection lifecycle management per instance with automatic reconnection

**Chatbot Integrations** (`src/api/integrations/chatbot/`):
- **EvolutionBot**: Native chatbot with trigger system
- **Chatwoot**: Customer service platform integration
- **Typebot**: Visual chatbot flow builder
- **OpenAI**: AI capabilities including GPT and Whisper (audio transcription)
- **Dify**: AI agent workflow platform
- **Flowise**: LangChain visual builder
- **N8N**: Workflow automation platform
- **EvoAI**: Custom AI integration

**Event Integrations** (`src/api/integrations/event/`):
- **WebSocket**: Real-time Socket.io connections
- **RabbitMQ**: Message queue for async processing
- **Amazon SQS**: Cloud-based message queuing
- **NATS**: High-performance messaging system
- **Pusher**: Real-time push notifications

**Storage Integrations** (`src/api/integrations/storage/`):
- **AWS S3**: Cloud object storage
- **MinIO**: Self-hosted S3-compatible storage
- Media file management and URL generation

### Database Schema Management
- Separate schema files: `postgresql-schema.prisma` and `mysql-schema.prisma`
- Environment variable `DATABASE_PROVIDER` determines active database
- Migration folders are provider-specific and auto-selected during deployment

### Authentication & Security
- **API key-based authentication** via `apikey` header (global or per-instance)
- **Instance-specific tokens** for WhatsApp connection authentication
- **Guards system** for route protection and authorization
- **Input validation** using JSONSchema7 with RouterBroker `dataValidate`
- **Rate limiting** and security middleware
- **Webhook signature validation** for external integrations

## Important Implementation Details

### WhatsApp Instance Management
- Each WhatsApp connection is an "instance" with unique name
- Instance data stored in database with connection state
- Session persistence in database or file system (configurable)
- Automatic reconnection handling with exponential backoff

### Message Queue Architecture
- Supports RabbitMQ, Amazon SQS, and WebSocket for events
- Event types: message.received, message.sent, connection.update, etc.
- Configurable per instance which events to send

### Media Handling
- Local storage or S3/Minio for media files
- Automatic media download from WhatsApp
- Media URL generation for external access
- Support for audio transcription via OpenAI

### Multi-tenancy Support
- Instance isolation at database level
- Separate webhook configurations per instance
- Independent integration settings per instance

## Environment Configuration

Key environment variables are defined in `.env.example`. The system uses a strongly-typed configuration system via `src/config/env.config.ts`.

Critical configurations:
- `DATABASE_PROVIDER`: postgresql or mysql
- `DATABASE_CONNECTION_URI`: Database connection string
- `AUTHENTICATION_API_KEY`: Global API authentication
- `REDIS_ENABLED`: Enable Redis cache
- `RABBITMQ_ENABLED`/`SQS_ENABLED`: Message queue options

## Development Guidelines

The project follows comprehensive development standards defined in `.cursor/rules/`:

### Core Principles
- **Always respond in Portuguese (PT-BR)** for user communication
- **Follow established architecture patterns** (Service Layer, RouterBroker, etc.)
- **Robust error handling** with retry logic and graceful degradation
- **Multi-database compatibility** (PostgreSQL and MySQL)
- **Security-first approach** with input validation and rate limiting
- **Performance optimizations** with Redis caching and connection pooling

### Code Standards
- **TypeScript strict mode** with full type coverage
- **JSONSchema7** for input validation (not class-validator)
- **Conventional Commits** enforced by commitlint
- **ESLint + Prettier** for code formatting
- **Service Object pattern** for business logic
- **RouterBroker pattern** for route handling with `dataValidate`

### Architecture Patterns
- **Multi-tenant isolation** at database and instance level
- **Event-driven communication** with EventEmitter2
- **Microservices integration** pattern for external services
- **Connection pooling** and lifecycle management
- **Caching strategy** with Redis primary and Node-cache fallback

## Testing Approach

See "Testes: toda mudança vem com teste" at the top of this file (Vitest, `tests/`).

## Deployment Considerations

- Docker support with `Dockerfile` and `docker-compose.yaml`
- Graceful shutdown handling for connections
- Health check endpoints for monitoring
- Sentry integration for error tracking
- Telemetry for usage analytics (non-sensitive data only)
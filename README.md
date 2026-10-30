# BaysSystems Growth OS

## Multi-Agent Marketing & Customer Development System

A TypeScript application coordinating five specialist AI roles around research, content, distribution, customer development, and internal auditing. The application includes a PostgreSQL-backed job queue, CRM, founder approvals, budget controls, and a mobile management panel.

**Status: development implementation with reported simulation tests. Live integrations have not been verified.**

## Customer Acquisition Engine V1 (yeni)

Üç sektörde (eğitim, güzellik, klinik) müşteri keşfi, onay kontrollü iletişim ve satış takibi yapan, telefondan yönetilebilen yeni sistem `acquisition-engine/` klasöründedir ve yukarıdaki arşivden bağımsızdır. Başlangıç: [acquisition-engine/README.md](acquisition-engine/README.md) · Durum: [acquisition-engine/IMPLEMENTATION_STATUS.md](acquisition-engine/IMPLEMENTATION_STATUS.md).

## Five specialist roles

| Role | Responsibility |
| --- | --- |
| Strategy | Plans using brand context, evidence, metrics, and constraints |
| Content | Drafts channel-specific content with evidence checks |
| Distribution | Schedules approved content and creates manual tasks for unsupported actions |
| Customer development | Evaluates sourced leads, drafts outreach, and handles opportunity handoff |
| Auditor | Reviews evidence, operational constraints, and improvement opportunities |

## System capabilities

- Persistent PostgreSQL task queue with retries and recovery
- Brand separation and role-scoped database access
- Human approval for founder-controlled decisions
- Budget reservations and reconciliation of uncertain provider charges
- Sourced research, lead tracking, reply handling, and opt-out processing
- Separate simulation, evaluation, and live modes
- LinkedIn, WhatsApp Cloud API, and n8n integration code
- WhatsApp founder reports and decision replies; this is not an appointment-booking product

## Source package

[Download the source code and documentation](bays-growth-os-v2.1.1-source.zip)

The archive contains the application, migrations, tests, panel, n8n workflow templates, setup guides, and historical development reports. Extract it and read `bays-growth-os/README.md` before configuring anything. Source is supplied as an archive in this portfolio repository.

### Local development

Requires Node.js 22 or later and PostgreSQL 16. The included Docker Compose configuration is an alternative setup path; a full Docker startup was not verified in the historical report.

```bash
unzip bays-growth-os-v2.1.1-source.zip
cd bays-growth-os
npm ci
cp .env.example .env
```

Configure the local database roles and placeholder settings using the included setup guide. Keep `RUN_MODE=simulation`, `EGRESS_ENABLED=false`, and `CUSTOMER_EMAIL_LIVE=false` while reviewing. Run database-creating commands only against a disposable local development database: the fresh-simulation and test setup paths recreate their target database.

## Verification and limitations

The package's 14 October 2026 development report records **107 passing tests**, 13 deterministic guard checks, and 20 mock quality-contract scenarios. These are historical reported results, not a new independent execution in this publication session. Mock quality checks do not establish real model quality.

Real AI output, LinkedIn publishing, WhatsApp delivery, email, Brave research, and n8n execution remain unverified. The panel was not browser-tested in the historical report. There is no claim of acquired customers, revenue, or production deployment.

## Publication scope

The source archive excludes the original Git history and local dependency directories. It includes only an example environment file with placeholder values. Sample reports and fixture data are demonstrations, not customer results. No open-source license is granted by this repository; no license file was supplied with the source package.

Built by Şeref Baysal, with AI-assisted development.

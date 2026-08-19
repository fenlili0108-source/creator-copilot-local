import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import {
  ArtifactManifestSchema,
  CommandEnvelopeSchema,
  CommandReceiptSchema,
  JobRecordSchema,
  assertJobTransition,
  stableStringify,
  type ArtifactManifest,
  type CommandEnvelope,
  type CommandReceipt,
  type JobRecord,
  type JobState,
} from "../../contracts/src/index.js";
import {
  EditProposalSchema,
  FrozenEditSpecSchema,
  type EditProposal,
  type FrozenEditSpec,
} from "../../exchange/src/index.js";
import {
  CapturePackageSchema,
  ScriptSchema,
  ScriptProposalSchema,
  ShootTaskSchema,
  StoryboardSchema,
  TakeSchema,
  attachTake,
  selectTake,
  type CapturePackage,
  type Script,
  type ScriptProposal,
  type ShootTask,
  type Storyboard,
  type Take,
} from "../../creation/src/index.js";
import { AnalysisFactSchema, searchQueryForFts, type AnalysisFact } from "../../analysis/src/index.js";
import { AccountResearchReportSchema, TopicRadarReportSchema, type AccountResearchReport, type TopicRadarReport } from "../../research/src/index.js";
import { MetricSnapshotSchema, PublicationSchema, ReviewMemoryProposalSchema, type MetricSnapshot, type Publication, type ReviewMemoryProposal } from "../../publishing/src/index.js";
import { TopicSchema, type Topic } from "../../domain/src/index.js";

const CURRENT_SCHEMA_VERSION = 11;

const RenderRunRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  frozenEditSpecId: z.string().min(1),
  state: z.enum(["running", "succeeded", "failed", "cancelled"]),
  manifestRelativePath: z.string().min(1).optional(),
  manifestHash: z.string().min(1).optional(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict().optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type RenderRunRecord = z.infer<typeof RenderRunRecordSchema>;

type WorkspaceRecord = {
  id: string;
  name: string;
  rootPath: string;
  schemaVersion: number;
  defaultLocale: string;
  createdAt: string;
  updatedAt: string;
};

type ProjectRecord = {
  id: string;
  workspaceId: string;
  title: string;
  stage: string;
  revision: number;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type StoredReceipt = {
  idempotencyScope: string;
  idempotencyKey: string;
  inputHash: string;
  receipt: CommandReceipt;
};

export type DomainEventRecord = {
  id: string;
  aggregateType: string;
  aggregateId: string;
  aggregateRevision: number;
  type: string;
  payload: Record<string, unknown>;
  actorType: "user" | "agent" | "system" | "provider";
  idempotencyKey?: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
};

export type OutboxRecord = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  idempotencyScope: string;
  state: "queued" | "claimed" | "sent" | "failed";
  attempt: number;
  workerId?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type CommandExecution = {
  receipt: CommandReceipt;
  events?: DomainEventRecord[];
  outbox?: OutboxRecord[];
};

const migrations: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      default_locale TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      stage TEXT NOT NULL,
      revision INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_workspace_idx ON projects(workspace_id);

    CREATE TABLE IF NOT EXISTS command_receipts (
      idempotency_scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (idempotency_scope, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS domain_events (
      id TEXT PRIMARY KEY NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      aggregate_revision INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      idempotency_key TEXT,
      correlation_id TEXT NOT NULL,
      causation_id TEXT,
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS domain_events_aggregate_idx
      ON domain_events(aggregate_type, aggregate_id, aggregate_revision);

    CREATE TABLE IF NOT EXISTS outbox_messages (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      idempotency_scope TEXT NOT NULL,
      state TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      worker_id TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (idempotency_scope, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS outbox_state_idx ON outbox_messages(state, lease_expires_at);

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      idempotency_scope TEXT NOT NULL,
      provider_key TEXT,
      external_job_id TEXT,
      worker_id TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      retry_after TEXT,
      checkpoint_json TEXT,
      source_run_id TEXT,
      correlation_id TEXT NOT NULL,
      artifact_ids_json TEXT NOT NULL,
      last_error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (idempotency_scope, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS jobs_state_idx ON jobs(state, retry_after);

    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      parent_artifact_ids_json TEXT NOT NULL,
      source_revision INTEGER,
      validation_status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (workspace_id, relative_path)
    );
  `,
  2: `
    CREATE TABLE IF NOT EXISTS outbox_messages (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      idempotency_scope TEXT NOT NULL,
      state TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      worker_id TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (idempotency_scope, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS outbox_state_idx ON outbox_messages(state, lease_expires_at);
  `,
  3: `
    CREATE TABLE IF NOT EXISTS scripts (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scripts_project_idx ON scripts(project_id, updated_at);

    CREATE TABLE IF NOT EXISTS storyboards (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE RESTRICT,
      script_revision INTEGER NOT NULL CHECK (script_revision > 0),
      revision INTEGER NOT NULL CHECK (revision > 0),
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS storyboards_project_idx ON storyboards(project_id, updated_at);

    CREATE TABLE IF NOT EXISTS shoot_tasks (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      shot_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shoot_tasks_project_idx ON shoot_tasks(project_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS shoot_tasks_shot_idx ON shoot_tasks(shot_id);

    CREATE TABLE IF NOT EXISTS capture_packages (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      storyboard_revision INTEGER NOT NULL CHECK (storyboard_revision > 0),
      status TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS capture_packages_project_idx ON capture_packages(project_id, updated_at);

    CREATE TABLE IF NOT EXISTS takes (
      id TEXT PRIMARY KEY NOT NULL,
      shoot_task_id TEXT NOT NULL REFERENCES shoot_tasks(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS takes_task_idx ON takes(shoot_task_id, status, created_at);
  `,
  4: `
    CREATE TABLE IF NOT EXISTS edit_proposals (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS edit_proposals_project_idx ON edit_proposals(project_id, updated_at);

    CREATE TABLE IF NOT EXISTS frozen_edit_specs (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_proposal_id TEXT REFERENCES edit_proposals(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK (revision > 0),
      authored_spec_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS frozen_edit_specs_project_idx ON frozen_edit_specs(project_id, updated_at);

    CREATE TABLE IF NOT EXISTS render_runs (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      frozen_edit_spec_id TEXT NOT NULL REFERENCES frozen_edit_specs(id) ON DELETE RESTRICT,
      state TEXT NOT NULL,
      manifest_relative_path TEXT,
      manifest_hash TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS render_runs_project_idx ON render_runs(project_id, updated_at);
  `,
  5: `
    CREATE TABLE IF NOT EXISTS media_analysis_facts (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
      end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
      text TEXT NOT NULL,
      labels_json TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      model_key TEXT,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS media_analysis_facts_artifact_idx ON media_analysis_facts(artifact_id, start_ms, end_ms);
    CREATE INDEX IF NOT EXISTS media_analysis_facts_workspace_idx ON media_analysis_facts(workspace_id, kind, created_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS media_analysis_fts USING fts5(
      fact_id UNINDEXED,
      workspace_id UNINDEXED,
      artifact_id UNINDEXED,
      kind UNINDEXED,
      text,
      labels,
      tokenize = 'unicode61'
    );
  `,
  6: `
    CREATE TABLE IF NOT EXISTS research_reports (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      provider_key TEXT NOT NULL,
      source_input TEXT NOT NULL,
      sec_user_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS research_reports_workspace_idx ON research_reports(workspace_id, created_at);
  `,
  7: `
    CREATE TABLE IF NOT EXISTS publications (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      package_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'failed', 'removed')),
      published_at TEXT,
      external_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS publications_project_idx ON publications(project_id, updated_at);
    CREATE TABLE IF NOT EXISTS metric_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
      captured_at TEXT NOT NULL,
      window TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('manual', 'connector')),
      metrics_json TEXT NOT NULL,
      source_evidence_id TEXT,
      notes TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS metric_snapshots_publication_idx ON metric_snapshots(publication_id, captured_at);
    CREATE TABLE IF NOT EXISTS review_memory_proposals (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      source_publication_ids_json TEXT NOT NULL,
      evidence_snapshot_ids_json TEXT NOT NULL,
      statement TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      applies_to_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('candidate', 'confirmed', 'rejected', 'expired')),
      created_at TEXT NOT NULL,
      confirmed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS review_memory_workspace_idx ON review_memory_proposals(workspace_id, created_at);
  `,
  8: `
    CREATE TABLE IF NOT EXISTS topic_radar_reports (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      provider_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed', 'partial', 'failed')),
      quote_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS topic_radar_reports_workspace_idx ON topic_radar_reports(workspace_id, created_at);
  `,
  9: `
    CREATE TABLE IF NOT EXISTS script_proposals (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('previewed', 'accepted', 'rejected', 'expired')),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS script_proposals_workspace_idx ON script_proposals(workspace_id, updated_at);
  `,
  10: `
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('candidate', 'selected', 'in_progress', 'used', 'archived')),
      revision INTEGER NOT NULL CHECK (revision > 0),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS topics_workspace_idx ON topics(workspace_id, status, updated_at);
  `,
  11: `
    ALTER TABLE media_analysis_facts ADD COLUMN analysis_run_id TEXT;
    CREATE INDEX IF NOT EXISTS media_analysis_facts_run_idx ON media_analysis_facts(artifact_id, analysis_run_id, start_ms, end_ms);
  `,
};

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`无法解析 ${label}`);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function toStoredJob(job: JobRecord) {
  return {
    id: job.id,
    kind: job.kind,
    inputHash: job.inputHash,
    state: job.state,
    attempt: job.attempt,
    idempotencyKey: job.idempotencyKey,
    idempotencyScope: job.idempotencyScope,
    providerKey: job.providerKey ?? null,
    externalJobId: job.externalJobId ?? null,
    workerId: job.workerId ?? null,
    leaseToken: job.leaseToken ?? null,
    leaseExpiresAt: job.leaseExpiresAt ?? null,
    heartbeatAt: job.heartbeatAt ?? null,
    retryAfter: job.retryAfter ?? null,
    checkpointJson: job.checkpoint ? JSON.stringify(job.checkpoint) : null,
    sourceRunId: job.sourceRunId ?? null,
    correlationId: job.correlationId,
    artifactIdsJson: JSON.stringify(job.artifactIds),
    lastErrorJson: job.lastError ? JSON.stringify(job.lastError) : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function fromStoredJob(row: Record<string, unknown>): JobRecord {
  return JobRecordSchema.parse({
    schemaVersion: 1,
    id: row.id,
    kind: row.kind,
    inputHash: row.input_hash,
    state: row.state,
    attempt: row.attempt,
    idempotencyKey: row.idempotency_key,
    idempotencyScope: row.idempotency_scope,
    providerKey: row.provider_key ?? undefined,
    externalJobId: row.external_job_id ?? undefined,
    workerId: row.worker_id ?? undefined,
    leaseToken: row.lease_token ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    heartbeatAt: row.heartbeat_at ?? undefined,
    retryAfter: row.retry_after ?? undefined,
    checkpoint: row.checkpoint_json ? parseJson(row.checkpoint_json as string, "job checkpoint") : undefined,
    sourceRunId: row.source_run_id ?? undefined,
    correlationId: row.correlation_id,
    artifactIds: parseJson<string[]>(row.artifact_ids_json as string, "job artifacts"),
    lastError: row.last_error_json ? parseJson(row.last_error_json as string, "job error") : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export class SqliteCatalog {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path, { timeout: 5000 });
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  close() {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }

  migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
    const row = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    const current = Number(row?.value ?? 0);
    if (!Number.isInteger(current) || current > CURRENT_SCHEMA_VERSION) {
      throw new Error(`不支持的数据库 schema 版本：${current}`);
    }
    const apply = this.db.transaction(() => {
      for (let version = current + 1; version <= CURRENT_SCHEMA_VERSION; version += 1) {
        this.db.exec(migrations[version]);
        if (version === 2) {
          const jobColumns = this.db.pragma("table_info(jobs)") as Array<{ name: string }>;
          if (!jobColumns.some((column) => column.name === "lease_token")) {
            this.db.exec("ALTER TABLE jobs ADD COLUMN lease_token TEXT");
          }
          const outboxColumns = this.db.pragma("table_info(outbox_messages)") as Array<{ name: string }>;
          if (!outboxColumns.some((column) => column.name === "lease_token")) {
            this.db.exec("ALTER TABLE outbox_messages ADD COLUMN lease_token TEXT");
          }
        }
        this.db.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(version));
      }
    });
    apply();
  }

  schemaVersion() {
    const row = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string };
    return Number(row.value);
  }

  createWorkspace(workspace: WorkspaceRecord) {
    if (!isAbsolute(workspace.rootPath)) throw new Error("工作区根目录必须是绝对路径");
    const requestedRoot = resolve(workspace.rootPath);
    if (!existsSync(requestedRoot) || !statSync(requestedRoot).isDirectory()) throw new Error("工作区根目录必须是已存在的目录");
    workspace = { ...workspace, rootPath: realpathSync(requestedRoot) };
    this.db.prepare(`INSERT INTO workspaces(id, name, root_path, schema_version, default_locale, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(workspace.id, workspace.name, workspace.rootPath, workspace.schemaVersion, workspace.defaultLocale, workspace.createdAt, workspace.updatedAt);
  }

  getWorkspace(id: string): WorkspaceRecord | undefined {
    return this.db.prepare(`SELECT id, name, root_path AS rootPath, schema_version AS schemaVersion, default_locale AS defaultLocale, created_at AS createdAt, updated_at AS updatedAt FROM workspaces WHERE id = ?`).get(id) as WorkspaceRecord | undefined;
  }

  createProject(project: ProjectRecord) {
    this.db.prepare(`INSERT INTO projects(id, workspace_id, title, stage, revision, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(project.id, project.workspaceId, project.title, project.stage, project.revision, JSON.stringify(project.payload), project.createdAt, project.updatedAt);
  }

  getProject(id: string): ProjectRecord | undefined {
    const row = this.db.prepare(`SELECT id, workspace_id AS workspaceId, title, stage, revision, payload_json, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id = ?`).get(id) as (Omit<ProjectRecord, "payload"> & { payload_json: string }) | undefined;
    if (!row) return undefined;
    return { ...row, payload: parseJson(row.payload_json, "project payload") } as ProjectRecord;
  }

  listProjectsForWorkspace(workspaceId: string) {
    const rows = this.db.prepare(`SELECT id, workspace_id AS workspaceId, title, stage, revision, payload_json, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE workspace_id = ? ORDER BY updated_at DESC, id DESC`).all(workspaceId) as Array<Omit<ProjectRecord, "payload"> & { payload_json: string }>;
    return rows.map((row) => ({ ...row, payload: parseJson(row.payload_json, "project payload") }) as ProjectRecord);
  }

  updateProject(id: string, expectedRevision: number, patch: { title?: string; stage?: string; payload?: Record<string, unknown> }) {
    const current = this.getProject(id);
    if (!current || current.revision !== expectedRevision) return false;
    const next = {
      title: patch.title ?? current.title,
      stage: patch.stage ?? current.stage,
      payload: patch.payload ?? current.payload,
      revision: current.revision + 1,
      updatedAt: nowIso(),
    };
    const result = this.db.prepare(`UPDATE projects SET title = ?, stage = ?, revision = ?, payload_json = ?, updated_at = ? WHERE id = ? AND revision = ?`)
      .run(next.title, next.stage, next.revision, JSON.stringify(next.payload), next.updatedAt, id, expectedRevision);
    return result.changes === 1;
  }

  saveScript(raw: Script) {
    const script = ScriptSchema.parse(raw);
    const current = this.db.prepare("SELECT revision FROM scripts WHERE id = ?").get(script.id) as { revision: number } | undefined;
    if (!current) {
      if (script.revision !== 1) return false;
      this.db.prepare("INSERT INTO scripts(id, project_id, revision, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(script.id, script.projectId, script.revision, script.status, JSON.stringify(script), script.createdAt, script.updatedAt);
      return true;
    }
    if (script.revision !== current.revision + 1) return false;
    const result = this.db.prepare("UPDATE scripts SET revision = ?, status = ?, payload_json = ?, updated_at = ? WHERE id = ? AND revision = ?")
      .run(script.revision, script.status, JSON.stringify(script), script.updatedAt, script.id, current.revision);
    return result.changes === 1;
  }

  getScript(id: string): Script | undefined {
    const row = this.db.prepare("SELECT payload_json FROM scripts WHERE id = ?").get(id) as { payload_json: string } | undefined;
    return row ? ScriptSchema.parse(parseJson(row.payload_json, "script")) : undefined;
  }

  saveScriptProposal(raw: ScriptProposal) {
    const proposal = ScriptProposalSchema.parse(raw);
    if (!this.getWorkspace(proposal.workspaceId)) throw new Error("脚本提案所属工作区不存在");
    const existing = this.getScriptProposal(proposal.id);
    if (existing && existing.workspaceId !== proposal.workspaceId) throw new Error("脚本提案不能跨工作区覆盖");
    if (existing && existing.status !== proposal.status && existing.status !== "previewed") throw new Error("已处理的脚本提案不能回退状态");
    this.db.prepare(`INSERT INTO script_proposals(id, workspace_id, status, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json, updated_at = excluded.updated_at`)
      .run(proposal.id, proposal.workspaceId, proposal.status, JSON.stringify(proposal), proposal.createdAt, proposal.updatedAt);
    return proposal;
  }

  acceptScriptProposal(input: { proposalId: string; workspaceId: string; project: ProjectRecord; script: Script }) {
    const transaction = this.db.transaction(() => {
      const proposal = this.getScriptProposal(input.proposalId);
      if (!proposal || proposal.workspaceId !== input.workspaceId) throw new Error("脚本提案不存在或不属于当前工作区");
      if (proposal.status !== "previewed") throw new Error("只有待审阅的脚本提案才能确认");
      if (input.project.workspaceId !== input.workspaceId || input.script.projectId !== input.project.id) throw new Error("脚本提案的项目归属不一致");
      const existingProject = this.getProject(input.project.id);
      if (!existingProject) this.createProject(input.project);
      else if (existingProject.workspaceId !== input.project.workspaceId) throw new Error("项目不属于当前工作区");
      const existingScript = this.getScript(input.script.id);
      if (!existingScript) {
        if (!this.saveScript(input.script)) throw new Error("脚本初始修订写入失败");
      } else if (stableStringify(existingScript) !== stableStringify(input.script)) {
        throw new Error("已有脚本版本与提案脚本不一致");
      }
      if (existingProject) {
        const projectUpdate = this.db.prepare("UPDATE projects SET title = ?, stage = ?, revision = ?, payload_json = ?, updated_at = ? WHERE id = ? AND revision = ?").run(input.project.title, input.project.stage, input.project.revision, JSON.stringify(input.project.payload), input.project.updatedAt, input.project.id, existingProject.revision);
        if (projectUpdate.changes !== 1) throw new Error("项目版本更新失败");
      }
      const accepted = ScriptProposalSchema.parse({ ...proposal, status: "accepted", updatedAt: input.script.updatedAt });
      this.db.prepare("UPDATE script_proposals SET status = 'accepted', payload_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'previewed'")
        .run(JSON.stringify(accepted), accepted.updatedAt, proposal.id, input.workspaceId);
      return { proposal: accepted, project: input.project, script: input.script };
    }).immediate;
    return transaction();
  }

  getScriptProposal(id: string): ScriptProposal | undefined {
    const row = this.db.prepare("SELECT payload_json FROM script_proposals WHERE id = ?").get(id) as { payload_json: string } | undefined;
    return row ? ScriptProposalSchema.parse(parseJson(row.payload_json, "script proposal")) : undefined;
  }

  updateScriptProposalStatus(id: string, workspaceId: string, status: ScriptProposal["status"], updatedAt = nowIso()) {
    const proposal = this.getScriptProposal(id);
    if (!proposal || proposal.workspaceId !== workspaceId) return false;
    if (proposal.status === "rejected" || proposal.status === "expired" || (proposal.status === "accepted" && status !== "accepted")) throw new Error("脚本提案已经结束，不能再次修改");
    const next = ScriptProposalSchema.parse({ ...proposal, status, updatedAt });
    const result = this.db.prepare("UPDATE script_proposals SET status = ?, payload_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status IN ('previewed', 'accepted')")
      .run(next.status, JSON.stringify(next), next.updatedAt, id, workspaceId);
    return result.changes === 1;
  }

  listScriptProposals(workspaceId: string, limit = 20) {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.db.prepare("SELECT payload_json FROM script_proposals WHERE workspace_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?").all(workspaceId, safeLimit) as Array<{ payload_json: string }>;
    return rows.map((row) => ScriptProposalSchema.parse(parseJson(row.payload_json, "script proposal")));
  }

  saveStoryboard(raw: Storyboard) {
    const storyboard = StoryboardSchema.parse(raw);
    const current = this.db.prepare("SELECT revision FROM storyboards WHERE id = ?").get(storyboard.id) as { revision: number } | undefined;
    if (!current) {
      if (storyboard.revision !== 1) return false;
      this.db.prepare("INSERT INTO storyboards(id, project_id, script_id, script_revision, revision, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(storyboard.id, storyboard.projectId, storyboard.scriptId, storyboard.scriptRevision, storyboard.revision, storyboard.status, JSON.stringify(storyboard), storyboard.createdAt, storyboard.updatedAt);
      return true;
    }
    if (storyboard.revision !== current.revision + 1) return false;
    const result = this.db.prepare("UPDATE storyboards SET script_id = ?, script_revision = ?, revision = ?, status = ?, payload_json = ?, updated_at = ? WHERE id = ? AND revision = ?")
      .run(storyboard.scriptId, storyboard.scriptRevision, storyboard.revision, storyboard.status, JSON.stringify(storyboard), storyboard.updatedAt, storyboard.id, current.revision);
    return result.changes === 1;
  }

  getStoryboard(id: string): Storyboard | undefined {
    const row = this.db.prepare("SELECT payload_json FROM storyboards WHERE id = ?").get(id) as { payload_json: string } | undefined;
    return row ? StoryboardSchema.parse(parseJson(row.payload_json, "storyboard")) : undefined;
  }

  saveShootTask(raw: ShootTask) {
    const task = ShootTaskSchema.parse(raw);
    this.db.prepare(`INSERT INTO shoot_tasks(id, project_id, shot_id, status, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json, updated_at = excluded.updated_at`)
      .run(task.id, task.projectId, task.shotId, task.status, JSON.stringify(task), task.createdAt, task.updatedAt);
    return task;
  }

  getShootTask(id: string): ShootTask | undefined {
    const row = this.db.prepare("SELECT payload_json FROM shoot_tasks WHERE id = ?").get(id) as { payload_json: string } | undefined;
    return row ? ShootTaskSchema.parse(parseJson(row.payload_json, "shoot task")) : undefined;
  }

  saveCapturePackage(raw: CapturePackage) {
    const capturePackage = CapturePackageSchema.parse(raw);
    this.db.prepare(`INSERT INTO capture_packages(id, project_id, storyboard_revision, status, relative_path, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET storyboard_revision = excluded.storyboard_revision, status = excluded.status, relative_path = excluded.relative_path, payload_json = excluded.payload_json, updated_at = excluded.updated_at`)
      .run(capturePackage.id, capturePackage.projectId, capturePackage.storyboardRevision, capturePackage.status, capturePackage.relativePath, JSON.stringify(capturePackage), capturePackage.createdAt, capturePackage.updatedAt);
    return capturePackage;
  }

  getCapturePackage(id: string): CapturePackage | undefined {
    const row = this.db.prepare("SELECT payload_json FROM capture_packages WHERE id = ?").get(id) as { payload_json: string } | undefined;
    return row ? CapturePackageSchema.parse(parseJson(row.payload_json, "capture package")) : undefined;
  }

  saveEditProposal(raw: EditProposal) {
    const proposal = EditProposalSchema.parse(raw);
    const current = this.db.prepare("SELECT revision FROM edit_proposals WHERE id = ?").get(proposal.id) as { revision: number } | undefined;
    if (!current) {
      this.db.prepare("INSERT INTO edit_proposals(id, project_id, revision, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(proposal.id, proposal.projectId, 1, proposal.status, JSON.stringify(proposal), proposal.createdAt, proposal.updatedAt);
      return true;
    }
    const result = this.db.prepare("UPDATE edit_proposals SET revision = ?, status = ?, payload_json = ?, updated_at = ? WHERE id = ? AND revision = ?")
      .run(current.revision + 1, proposal.status, JSON.stringify(proposal), proposal.updatedAt, proposal.id, current.revision);
    return result.changes === 1;
  }

  getEditProposal(id: string): EditProposal | undefined {
    const row = this.db.prepare("SELECT payload_json FROM edit_proposals WHERE id = ?").get(id) as { payload_json: string } | undefined;
    return row ? EditProposalSchema.parse(parseJson(row.payload_json, "edit proposal")) : undefined;
  }

  saveFrozenEditSpec(raw: FrozenEditSpec) {
    const spec = FrozenEditSpecSchema.parse(raw);
    const current = this.db.prepare("SELECT revision, authored_spec_hash AS authoredSpecHash FROM frozen_edit_specs WHERE id = ?").get(spec.id) as { revision: number; authoredSpecHash: string } | undefined;
    if (!current) {
      this.db.prepare("INSERT INTO frozen_edit_specs(id, project_id, source_proposal_id, revision, authored_spec_hash, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(spec.id, spec.projectId, spec.sourceProposalId ?? null, spec.revision, spec.authoredSpecHash, JSON.stringify(spec), spec.createdAt, spec.updatedAt);
      return true;
    }
    if (current.authoredSpecHash === spec.authoredSpecHash && current.revision === spec.revision) return true;
    if (spec.revision !== current.revision + 1) return false;
    const result = this.db.prepare("UPDATE frozen_edit_specs SET source_proposal_id = ?, revision = ?, authored_spec_hash = ?, payload_json = ?, updated_at = ? WHERE id = ? AND revision = ?")
      .run(spec.sourceProposalId ?? null, spec.revision, spec.authoredSpecHash, JSON.stringify(spec), spec.updatedAt, spec.id, current.revision);
    return result.changes === 1;
  }

  getFrozenEditSpec(id: string): FrozenEditSpec | undefined {
    const row = this.db.prepare("SELECT payload_json FROM frozen_edit_specs WHERE id = ?").get(id) as { payload_json: string } | undefined;
    return row ? FrozenEditSpecSchema.parse(parseJson(row.payload_json, "frozen edit spec")) : undefined;
  }

  saveRenderRun(raw: RenderRunRecord) {
    const run = RenderRunRecordSchema.parse(raw);
    this.db.prepare(`INSERT INTO render_runs(id, project_id, frozen_edit_spec_id, state, manifest_relative_path, manifest_hash, error_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state = excluded.state, manifest_relative_path = excluded.manifest_relative_path, manifest_hash = excluded.manifest_hash, error_json = excluded.error_json, updated_at = excluded.updated_at`)
      .run(run.id, run.projectId, run.frozenEditSpecId, run.state, run.manifestRelativePath ?? null, run.manifestHash ?? null, run.error ? JSON.stringify(run.error) : null, run.createdAt, run.updatedAt);
    return run;
  }

  getRenderRun(id: string): RenderRunRecord | undefined {
    const row = this.db.prepare("SELECT id, project_id AS projectId, frozen_edit_spec_id AS frozenEditSpecId, state, manifest_relative_path AS manifestRelativePath, manifest_hash AS manifestHash, error_json AS errorJson, created_at AS createdAt, updated_at AS updatedAt FROM render_runs WHERE id = ?").get(id) as (Omit<RenderRunRecord, "error"> & { errorJson?: string | null }) | undefined;
    if (!row) return undefined;
    const { errorJson, schemaVersion: _schemaVersion, ...record } = row;
    return RenderRunRecordSchema.parse({ schemaVersion: 1, ...record, manifestRelativePath: row.manifestRelativePath ?? undefined, manifestHash: row.manifestHash ?? undefined, error: errorJson ? parseJson(errorJson, "render run error") : undefined });
  }

  listRenderRunsForProject(projectId: string) {
    const rows = this.db.prepare("SELECT id FROM render_runs WHERE project_id = ? ORDER BY updated_at DESC, id DESC").all(projectId) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const run = this.getRenderRun(row.id);
      return run ? [run] : [];
    });
  }

  saveAnalysisFacts(rawFacts: AnalysisFact[]) {
    const facts = rawFacts.map((fact) => AnalysisFactSchema.parse(fact));
    const transaction = this.db.transaction(() => {
      for (const fact of facts) {
        const workspace = this.getWorkspace(fact.workspaceId);
        const artifact = this.getArtifact(fact.artifactId);
        if (!workspace || !artifact || artifact.workspaceId !== fact.workspaceId) throw new Error(`分析事实引用了不存在或跨工作区素材：${fact.id}`);
        this.db.prepare("DELETE FROM media_analysis_fts WHERE fact_id = ?").run(fact.id);
        this.db.prepare(`INSERT INTO media_analysis_facts(id, workspace_id, artifact_id, kind, start_ms, end_ms, text, labels_json, provider_key, model_key, content_hash, analysis_run_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, artifact_id = excluded.artifact_id, kind = excluded.kind, start_ms = excluded.start_ms, end_ms = excluded.end_ms, text = excluded.text, labels_json = excluded.labels_json, provider_key = excluded.provider_key, model_key = excluded.model_key, content_hash = excluded.content_hash, analysis_run_id = excluded.analysis_run_id, created_at = excluded.created_at`)
          .run(fact.id, fact.workspaceId, fact.artifactId, fact.kind, fact.startMs, fact.endMs, fact.text, JSON.stringify(fact.labels), fact.providerKey, fact.modelKey ?? null, fact.contentHash, fact.analysisRunId ?? null, fact.createdAt);
        this.db.prepare("INSERT INTO media_analysis_fts(fact_id, workspace_id, artifact_id, kind, text, labels) VALUES (?, ?, ?, ?, ?, ?)")
          .run(fact.id, fact.workspaceId, fact.artifactId, fact.kind, fact.text, fact.labels.join(" "));
      }
    }).immediate;
    transaction();
    return facts;
  }

  getAnalysisFact(id: string): AnalysisFact | undefined {
    const row = this.db.prepare(`SELECT id, workspace_id AS workspaceId, artifact_id AS artifactId, kind, start_ms AS startMs, end_ms AS endMs, text, labels_json AS labelsJson, provider_key AS providerKey, model_key AS modelKey, content_hash AS contentHash, analysis_run_id AS analysisRunId, created_at AS createdAt FROM media_analysis_facts WHERE id = ?`).get(id) as (Omit<AnalysisFact, "labels"> & { labelsJson: string }) | undefined;
    if (!row) return undefined;
    return AnalysisFactSchema.parse({ schemaVersion: 1, id: row.id, workspaceId: row.workspaceId, artifactId: row.artifactId, kind: row.kind, startMs: row.startMs, endMs: row.endMs, text: row.text, labels: parseJson<string[]>(row.labelsJson, "analysis labels"), providerKey: row.providerKey, modelKey: row.modelKey ?? undefined, contentHash: row.contentHash, analysisRunId: row.analysisRunId ?? undefined, createdAt: row.createdAt });
  }

  searchAnalysisFacts(input: { workspaceId: string; artifactId?: string; analysisRunId?: string; query?: string; kind?: AnalysisFact["kind"]; limit?: number }) {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const normalizedQuery = input.query?.trim() ?? "";
    const rows = normalizedQuery
      ? input.analysisRunId
        ? this.db.prepare(`SELECT media_analysis_fts.fact_id AS factId FROM media_analysis_fts JOIN media_analysis_facts AS facts ON facts.id = media_analysis_fts.fact_id WHERE media_analysis_fts MATCH ? AND media_analysis_fts.workspace_id = ? AND facts.analysis_run_id = ? LIMIT ?`).all(searchQueryForFts(normalizedQuery), input.workspaceId, input.analysisRunId, limit * 4) as Array<{ factId: string }>
        : this.db.prepare(`SELECT fact_id AS factId FROM media_analysis_fts WHERE media_analysis_fts MATCH ? AND workspace_id = ? LIMIT ?`).all(searchQueryForFts(normalizedQuery), input.workspaceId, limit * 4) as Array<{ factId: string }>
      : input.analysisRunId
        ? this.db.prepare("SELECT id AS factId FROM media_analysis_facts WHERE workspace_id = ? AND analysis_run_id = ? ORDER BY created_at DESC, id LIMIT ?").all(input.workspaceId, input.analysisRunId, limit * 4) as Array<{ factId: string }>
        : this.db.prepare("SELECT id AS factId FROM media_analysis_facts WHERE workspace_id = ? ORDER BY created_at DESC, id LIMIT ?").all(input.workspaceId, limit * 4) as Array<{ factId: string }>;
    const results: AnalysisFact[] = [];
    for (const row of rows) {
      const fact = this.getAnalysisFact(row.factId);
      if (!fact || fact.workspaceId !== input.workspaceId || (input.artifactId && fact.artifactId !== input.artifactId) || (input.kind && fact.kind !== input.kind)) continue;
      if (!results.some((candidate) => candidate.id === fact.id)) results.push(fact);
      if (results.length >= limit) break;
    }
    if (results.length === 0 && normalizedQuery) {
      const like = `%${normalizedQuery.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      const fallbackRows = input.analysisRunId
        ? this.db.prepare("SELECT id AS factId FROM media_analysis_facts WHERE workspace_id = ? AND analysis_run_id = ? AND text LIKE ? ESCAPE '\\' ORDER BY start_ms, id LIMIT ?").all(input.workspaceId, input.analysisRunId, like, limit) as Array<{ factId: string }>
        : this.db.prepare("SELECT id AS factId FROM media_analysis_facts WHERE workspace_id = ? AND text LIKE ? ESCAPE '\\' ORDER BY start_ms, id LIMIT ?").all(input.workspaceId, like, limit) as Array<{ factId: string }>;
      for (const row of fallbackRows) {
        const fact = this.getAnalysisFact(row.factId);
        if (fact && (!input.artifactId || fact.artifactId === input.artifactId) && (!input.kind || fact.kind === input.kind)) results.push(fact);
      }
    }
    return results;
  }

  saveResearchReport(raw: AccountResearchReport) {
    const report = AccountResearchReportSchema.parse(raw);
    if (!this.getWorkspace(report.workspaceId)) throw new Error("研究报告所属工作区不存在");
    this.db.prepare(`INSERT INTO research_reports(id, workspace_id, provider_key, source_input, sec_user_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET provider_key = excluded.provider_key, source_input = excluded.source_input, sec_user_id = excluded.sec_user_id, payload_json = excluded.payload_json, created_at = excluded.created_at`)
      .run(report.id, report.workspaceId, report.providerKey, report.sourceInput, report.secUserId, JSON.stringify(report), report.createdAt);
    return report;
  }

  getResearchReport(id: string): AccountResearchReport | undefined {
    const row = this.db.prepare("SELECT payload_json FROM research_reports WHERE id = ?").get(id) as { payload_json: string } | undefined;
    return row ? AccountResearchReportSchema.parse(parseJson(row.payload_json, "research report")) : undefined;
  }

  listResearchReports(workspaceId: string) {
    const rows = this.db.prepare("SELECT id FROM research_reports WHERE workspace_id = ? ORDER BY created_at DESC, id").all(workspaceId) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const report = this.getResearchReport(row.id);
      return report ? [report] : [];
    });
  }

  saveTopicRadarReport(raw: TopicRadarReport) {
    const report = TopicRadarReportSchema.parse(raw);
    if (!this.getWorkspace(report.workspaceId)) throw new Error("选题雷达报告所属工作区不存在");
    const existing = this.db.prepare("SELECT workspace_id FROM topic_radar_reports WHERE id = ?").get(report.id) as { workspace_id?: string } | undefined;
    if (existing?.workspace_id && existing.workspace_id !== report.workspaceId) throw new Error("选题雷达报告不能跨工作区覆盖");
    this.db.prepare(`INSERT INTO topic_radar_reports(id, workspace_id, provider_key, status, quote_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, quote_id = excluded.quote_id, payload_json = excluded.payload_json, created_at = excluded.created_at`)
      .run(report.id, report.workspaceId, report.providerKey, report.status, report.quote.id, JSON.stringify(report), report.createdAt);
    return report;
  }

  getTopicRadarReport(id: string): TopicRadarReport | undefined {
    const row = this.db.prepare("SELECT payload_json FROM topic_radar_reports WHERE id = ?").get(id) as { payload_json: string } | undefined;
    return row ? TopicRadarReportSchema.parse(parseJson(row.payload_json, "topic radar report")) : undefined;
  }

  listTopicRadarReports(workspaceId: string) {
    const rows = this.db.prepare("SELECT id FROM topic_radar_reports WHERE workspace_id = ? ORDER BY created_at DESC, id").all(workspaceId) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const report = this.getTopicRadarReport(row.id);
      return report ? [report] : [];
    });
  }

  saveTopic(raw: Topic) {
    const topic = TopicSchema.parse(raw);
    if (!this.getWorkspace(topic.workspaceId)) throw new Error("选题所属工作区不存在");
    const existing = this.db.prepare("SELECT workspace_id AS workspaceId FROM topics WHERE id = ?").get(topic.id) as { workspaceId?: string } | undefined;
    if (existing?.workspaceId && existing.workspaceId !== topic.workspaceId) throw new Error("选题不能跨工作区覆盖");
    this.db.prepare(`INSERT INTO topics(id, workspace_id, status, revision, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, revision = excluded.revision, payload_json = excluded.payload_json, updated_at = excluded.updated_at`)
      .run(topic.id, topic.workspaceId, topic.status, topic.revision, JSON.stringify(topic), topic.createdAt, topic.updatedAt);
    return topic;
  }

  getTopic(id: string): Topic | undefined {
    const row = this.db.prepare("SELECT payload_json FROM topics WHERE id = ?").get(id) as { payload_json: string } | undefined;
    return row ? TopicSchema.parse(parseJson(row.payload_json, "topic")) : undefined;
  }

  listTopics(workspaceId: string, status?: Topic["status"]) {
    const rows = status
      ? this.db.prepare("SELECT id FROM topics WHERE workspace_id = ? AND status = ? ORDER BY updated_at DESC, id").all(workspaceId, status) as Array<{ id: string }>
      : this.db.prepare("SELECT id FROM topics WHERE workspace_id = ? ORDER BY updated_at DESC, id").all(workspaceId) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const topic = this.getTopic(row.id);
      return topic && topic.workspaceId === workspaceId ? [topic] : [];
    });
  }

  /**
   * Human confirmation boundary for a candidate topic. The update is a
   * compare-and-swap on the topic revision so a stale UI cannot silently
   * confirm a topic that another session has already changed.
   */
  selectTopic(id: string, workspaceId: string, expectedRevision?: number, updatedAt = nowIso()) {
    const current = this.getTopic(id);
    if (!current) return undefined;
    if (current.workspaceId !== workspaceId) throw new Error("选题不属于当前工作区");
    if (current.status === "selected") {
      if (expectedRevision !== undefined && expectedRevision !== current.revision) return undefined;
      return current;
    }
    if (current.status !== "candidate") throw new Error(`当前选题状态不能确认：${current.status}`);
    const expected = expectedRevision ?? current.revision;
    if (!Number.isInteger(expected) || expected < 1 || current.revision !== expected) return undefined;
    const next = TopicSchema.parse({ ...current, status: "selected", revision: current.revision + 1, updatedAt });
    const result = this.db.prepare(`UPDATE topics SET status = ?, revision = ?, payload_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'candidate' AND revision = ?`)
      .run(next.status, next.revision, JSON.stringify(next), next.updatedAt, next.id, workspaceId, expected);
    return result.changes === 1 ? next : undefined;
  }

  savePublication(raw: Publication) {
    const publication = PublicationSchema.parse(raw);
    if (!this.getProject(publication.projectId)) throw new Error("发布记录所属项目不存在");
    this.db.prepare(`INSERT INTO publications(id, project_id, package_id, platform, status, published_at, external_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET package_id = excluded.package_id, platform = excluded.platform, status = excluded.status, published_at = excluded.published_at, external_id = excluded.external_id, updated_at = excluded.updated_at`)
      .run(publication.id, publication.projectId, publication.packageId, publication.platform, publication.status, publication.publishedAt ?? null, publication.externalId ?? null, publication.createdAt, publication.updatedAt);
    return publication;
  }

  getPublication(id: string): Publication | undefined {
    const row = this.db.prepare(`SELECT id, project_id AS projectId, package_id AS packageId, platform, status, published_at AS publishedAt, external_id AS externalId, created_at AS createdAt, updated_at AS updatedAt FROM publications WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return PublicationSchema.parse({ schemaVersion: 1, ...row, publishedAt: row.publishedAt ?? undefined, externalId: row.externalId ?? undefined });
  }

  listPublications(projectId: string) {
    const rows = this.db.prepare("SELECT id FROM publications WHERE project_id = ? ORDER BY updated_at DESC, id").all(projectId) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const publication = this.getPublication(row.id);
      return publication ? [publication] : [];
    });
  }

  listPublicationsForWorkspace(workspaceId: string) {
    const rows = this.db.prepare("SELECT publications.id FROM publications JOIN projects ON projects.id = publications.project_id WHERE projects.workspace_id = ? ORDER BY publications.updated_at DESC, publications.id").all(workspaceId) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const publication = this.getPublication(row.id);
      return publication ? [publication] : [];
    });
  }

  saveMetricSnapshot(raw: MetricSnapshot) {
    const snapshot = MetricSnapshotSchema.parse(raw);
    if (!this.getPublication(snapshot.publicationId)) throw new Error("指标对应的发布记录不存在");
    this.db.prepare(`INSERT INTO metric_snapshots(id, publication_id, captured_at, window, source, metrics_json, source_evidence_id, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET publication_id = excluded.publication_id, captured_at = excluded.captured_at, window = excluded.window, source = excluded.source, metrics_json = excluded.metrics_json, source_evidence_id = excluded.source_evidence_id, notes = excluded.notes`)
      .run(snapshot.id, snapshot.publicationId, snapshot.capturedAt, snapshot.window, snapshot.source, JSON.stringify(snapshot.metrics), snapshot.sourceEvidenceId ?? null, snapshot.notes);
    return snapshot;
  }

  getMetricSnapshot(id: string): MetricSnapshot | undefined {
    const row = this.db.prepare(`SELECT id, publication_id AS publicationId, captured_at AS capturedAt, window, source, metrics_json AS metricsJson, source_evidence_id AS sourceEvidenceId, notes FROM metric_snapshots WHERE id = ?`).get(id) as (Record<string, unknown> & { metricsJson?: string }) | undefined;
    if (!row) return undefined;
    return MetricSnapshotSchema.parse({ schemaVersion: 1, id: row.id, publicationId: row.publicationId, capturedAt: row.capturedAt, window: row.window, source: row.source, metrics: parseJson(row.metricsJson ?? "{}", "metric snapshot"), sourceEvidenceId: row.sourceEvidenceId ?? undefined, notes: row.notes });
  }

  listMetricSnapshots(publicationId: string) {
    const rows = this.db.prepare("SELECT id FROM metric_snapshots WHERE publication_id = ? ORDER BY captured_at, id").all(publicationId) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const snapshot = this.getMetricSnapshot(row.id);
      return snapshot ? [snapshot] : [];
    });
  }

  saveReviewMemoryProposal(raw: ReviewMemoryProposal) {
    const proposal = ReviewMemoryProposalSchema.parse(raw);
    if (!this.getWorkspace(proposal.workspaceId)) throw new Error("复盘记忆建议所属工作区不存在");
    for (const publicationId of proposal.sourcePublicationIds) {
      const publication = this.getPublication(publicationId);
      const project = publication ? this.getProject(publication.projectId) : undefined;
      if (!publication || !project || project.workspaceId !== proposal.workspaceId) throw new Error("复盘记忆建议引用了跨工作区或不存在的发布记录");
    }
    for (const snapshotId of proposal.evidenceSnapshotIds) {
      if (!this.getMetricSnapshot(snapshotId)) throw new Error("复盘记忆建议引用了不存在的指标证据");
    }
    this.db.prepare(`INSERT INTO review_memory_proposals(id, workspace_id, source_publication_ids_json, evidence_snapshot_ids_json, statement, confidence, applies_to_json, status, created_at, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET source_publication_ids_json = excluded.source_publication_ids_json, evidence_snapshot_ids_json = excluded.evidence_snapshot_ids_json, statement = excluded.statement, confidence = excluded.confidence, applies_to_json = excluded.applies_to_json, status = excluded.status, confirmed_at = excluded.confirmed_at`)
      .run(proposal.id, proposal.workspaceId, JSON.stringify(proposal.sourcePublicationIds), JSON.stringify(proposal.evidenceSnapshotIds), proposal.statement, proposal.confidence, JSON.stringify(proposal.appliesTo), proposal.status, proposal.createdAt, proposal.confirmedAt ?? null);
    return proposal;
  }

  getReviewMemoryProposal(id: string): ReviewMemoryProposal | undefined {
    const row = this.db.prepare(`SELECT id, workspace_id AS workspaceId, source_publication_ids_json AS sourcePublicationIdsJson, evidence_snapshot_ids_json AS evidenceSnapshotIdsJson, statement, confidence, applies_to_json AS appliesToJson, status, created_at AS createdAt, confirmed_at AS confirmedAt FROM review_memory_proposals WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return ReviewMemoryProposalSchema.parse({ schemaVersion: 1, id: row.id, workspaceId: row.workspaceId, sourcePublicationIds: parseJson(row.sourcePublicationIdsJson as string, "review publication evidence"), evidenceSnapshotIds: parseJson(row.evidenceSnapshotIdsJson as string, "review metric evidence"), statement: row.statement, confidence: row.confidence, appliesTo: parseJson(row.appliesToJson as string, "review applicability"), status: row.status, createdAt: row.createdAt, confirmedAt: row.confirmedAt ?? undefined });
  }

  listReviewMemoryProposals(workspaceId: string) {
    const rows = this.db.prepare("SELECT id FROM review_memory_proposals WHERE workspace_id = ? ORDER BY created_at DESC, id").all(workspaceId) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const proposal = this.getReviewMemoryProposal(row.id);
      return proposal ? [proposal] : [];
    });
  }

  confirmReviewMemoryProposal(id: string, confirmedAt = nowIso()) {
    const current = this.getReviewMemoryProposal(id);
    if (!current) return false;
    if (current.status !== "candidate") throw new Error("只有待确认的复盘记忆建议才能确认");
    const result = this.db.prepare("UPDATE review_memory_proposals SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND status = 'candidate'").run(confirmedAt, id);
    return result.changes === 1;
  }

  saveCaptureWorkflow(input: { project: ProjectRecord; script: Script; storyboard: Storyboard; tasks: ShootTask[]; capturePackage: CapturePackage }) {
    const transaction = this.db.transaction(() => {
      if (input.script.projectId !== input.project.id || input.storyboard.projectId !== input.project.id || input.capturePackage.projectId !== input.project.id) throw new Error("创作工作流的 projectId 不一致");
      if (input.storyboard.scriptId !== input.script.id || input.storyboard.scriptRevision !== input.script.revision) throw new Error("分镜没有引用当前脚本修订");
      const taskIds = new Set(input.tasks.map((task) => task.id));
      if (input.capturePackage.taskIds.some((taskId) => !taskIds.has(taskId))) throw new Error("拍摄包引用了不存在的任务");
      const existingProject = this.getProject(input.project.id);
      if (!existingProject) {
        this.createProject(input.project);
      } else {
        if (existingProject.workspaceId !== input.project.workspaceId) throw new Error("项目不属于当前工作区");
        if (input.project.revision !== existingProject.revision) throw new Error("项目版本已变化，请重新打开创作工作流");
        if (!this.updateProject(existingProject.id, existingProject.revision, { title: input.project.title, stage: input.project.stage, payload: input.project.payload })) throw new Error("项目版本更新失败");
      }
      const existingScript = this.getScript(input.script.id);
      if (!existingScript) {
        if (!this.saveScript(input.script)) throw new Error("脚本初始修订写入失败");
      } else if (stableStringify(existingScript) !== stableStringify(input.script)) {
        if (existingScript.projectId !== input.script.projectId || input.script.revision !== existingScript.revision + 1 || !this.saveScript(input.script)) throw new Error("已有脚本版本与拍摄包脚本不一致");
      }
      if (!this.saveStoryboard(input.storyboard)) throw new Error("分镜初始修订写入失败");
      for (const task of input.tasks) this.saveShootTask(task);
      this.saveCapturePackage(input.capturePackage);
    }).immediate;
    transaction();
  }

  addTake(raw: Take) {
    const take = TakeSchema.parse(raw);
    const transaction = this.db.transaction(() => {
      if (this.getTake(take.id)) return false;
      const task = this.getShootTask(take.shootTaskId);
      if (!task) throw new Error("Take 对应的拍摄任务不存在");
      this.db.prepare("INSERT INTO takes(id, shoot_task_id, asset_id, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(take.id, take.shootTaskId, take.assetId, take.status, JSON.stringify(take), take.createdAt, take.updatedAt);
      this.saveShootTask(attachTake(task, take));
      return true;
    }).immediate;
    return transaction();
  }

  getTake(id: string): Take | undefined {
    const row = this.db.prepare("SELECT payload_json FROM takes WHERE id = ?").get(id) as { payload_json: string } | undefined;
    return row ? TakeSchema.parse(parseJson(row.payload_json, "take")) : undefined;
  }

  listTakes(shootTaskId: string): Take[] {
    const rows = this.db.prepare("SELECT payload_json FROM takes WHERE shoot_task_id = ? ORDER BY created_at, id").all(shootTaskId) as Array<{ payload_json: string }>;
    return rows.map((row) => TakeSchema.parse(parseJson(row.payload_json, "take")));
  }

  selectTakeForTask(shootTaskId: string, takeId: string) {
    const transaction = this.db.transaction(() => {
      const task = this.getShootTask(shootTaskId);
      if (!task) throw new Error("拍摄任务不存在");
      const selection = selectTake(task, this.listTakes(shootTaskId), takeId);
      this.saveShootTask(selection.task);
      const statement = this.db.prepare("UPDATE takes SET status = ?, payload_json = ?, updated_at = ? WHERE id = ? AND shoot_task_id = ?");
      for (const take of selection.takes) statement.run(take.status, JSON.stringify(take), take.updatedAt, take.id, shootTaskId);
      return selection;
    }).immediate;
    return transaction();
  }

  saveReceipt(input: StoredReceipt) {
    const receipt = CommandReceiptSchema.parse(input.receipt);
    const existing = this.getReceipt(input.idempotencyScope, input.idempotencyKey);
    if (existing && existing.inputHash !== input.inputHash) throw new Error("IDEMPOTENCY_KEY_REUSE");
    if (existing) return existing.receipt;
    this.db.prepare(`INSERT OR IGNORE INTO command_receipts(idempotency_scope, idempotency_key, input_hash, receipt_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.idempotencyScope, input.idempotencyKey, input.inputHash, JSON.stringify(receipt), nowIso());
    const saved = this.getReceipt(input.idempotencyScope, input.idempotencyKey);
    if (!saved) throw new Error("命令回执未能持久化");
    if (saved.inputHash !== input.inputHash) throw new Error("IDEMPOTENCY_KEY_REUSE");
    return saved.receipt;
  }

  getReceipt(scope: string, key: string): StoredReceipt | undefined {
    const row = this.db.prepare(`SELECT idempotency_scope AS idempotencyScope, idempotency_key AS idempotencyKey, input_hash AS inputHash, receipt_json AS receiptJson FROM command_receipts WHERE idempotency_scope = ? AND idempotency_key = ?`).get(scope, key) as (Omit<StoredReceipt, "receipt"> & { receiptJson: string }) | undefined;
    if (!row) return undefined;
    return { idempotencyScope: row.idempotencyScope, idempotencyKey: row.idempotencyKey, inputHash: row.inputHash, receipt: CommandReceiptSchema.parse(parseJson(row.receiptJson, "command receipt")) };
  }

  getReceiptByCorrelation(scope: string, correlationId: string): StoredReceipt | undefined {
    const row = this.db.prepare(`SELECT idempotency_scope AS idempotencyScope, idempotency_key AS idempotencyKey, input_hash AS inputHash, receipt_json AS receiptJson FROM command_receipts WHERE idempotency_scope = ? AND json_extract(receipt_json, '$.correlationId') = ?`).get(scope, correlationId) as (Omit<StoredReceipt, "receipt"> & { receiptJson: string }) | undefined;
    if (!row) return undefined;
    return { idempotencyScope: row.idempotencyScope, idempotencyKey: row.idempotencyKey, inputHash: row.inputHash, receipt: CommandReceiptSchema.parse(parseJson(row.receiptJson, "command receipt")) };
  }

  listPendingCommandReceipts(scope: string, targetType: string, targetId: string, errorCode?: string) {
    const rows = this.db.prepare(`SELECT idempotency_scope AS idempotencyScope, idempotency_key AS idempotencyKey, input_hash AS inputHash, receipt_json AS receiptJson FROM command_receipts WHERE idempotency_scope = ? AND json_extract(receipt_json, '$.target.type') = ? AND json_extract(receipt_json, '$.target.id') = ? AND json_extract(receipt_json, '$.status') = 'pending' ORDER BY created_at DESC`).all(scope, targetType, targetId) as Array<Omit<StoredReceipt, "receipt"> & { receiptJson: string }>;
    return rows.flatMap((row) => {
      const receipt = CommandReceiptSchema.parse(parseJson(row.receiptJson, "command receipt"));
      if (errorCode && receipt.errorCode !== errorCode) return [];
      return [{ idempotencyScope: row.idempotencyScope, idempotencyKey: row.idempotencyKey, inputHash: row.inputHash, receipt }];
    });
  }

  executeCommand(raw: unknown, handler: (command: CommandEnvelope) => CommandExecution): CommandReceipt {
    const command = CommandEnvelopeSchema.parse(raw);
    const inputHash = stableStringify({ actor: command.actor, name: command.name, target: command.target, input: command.input });
    const transaction = this.db.transaction(() => {
      const existing = this.getReceipt(command.idempotencyScope, command.idempotencyKey);
      if (existing) {
        if (existing.inputHash !== inputHash) throw new Error("IDEMPOTENCY_KEY_REUSE");
        return { ...existing.receipt, status: "duplicate" as const };
      }
      const execution = handler(command);
      const receipt = CommandReceiptSchema.parse(execution.receipt);
      if (receipt.commandId !== command.commandId || receipt.correlationId !== command.correlationId || stableStringify(receipt.target) !== stableStringify(command.target)) {
        throw new Error("命令回执与请求的 commandId/correlationId 不一致");
      }
      for (const event of execution.events ?? []) this.appendEvent(event);
      for (const outbox of execution.outbox ?? []) this.enqueueOutbox(outbox);
      this.saveReceipt({ idempotencyScope: command.idempotencyScope, idempotencyKey: command.idempotencyKey, inputHash, receipt });
      return receipt;
    }).immediate;
    return transaction();
  }

  /**
   * Completes a previously persisted pending command without allowing the
   * caller to silently replace a different idempotency input. Domain writes,
   * job transitions, events/outbox and the final receipt share one SQLite
   * transaction, so a crash cannot leave an accepted receipt without its
   * proposal (or vice versa).
   */
  finalizeCommand(raw: unknown, handler: (command: CommandEnvelope, previous: CommandReceipt) => CommandExecution): CommandReceipt {
    const command = CommandEnvelopeSchema.parse(raw);
    const inputHash = stableStringify({ actor: command.actor, name: command.name, target: command.target, input: command.input });
    const transaction = this.db.transaction(() => {
      const existing = this.getReceipt(command.idempotencyScope, command.idempotencyKey);
      if (!existing) throw new Error("待完成的命令回执不存在");
      if (existing.inputHash !== inputHash) throw new Error("IDEMPOTENCY_KEY_REUSE");
      if (existing.receipt.status !== "pending") return { ...existing.receipt, status: "duplicate" as const };
      const execution = handler(command, existing.receipt);
      const receipt = CommandReceiptSchema.parse(execution.receipt);
      if (receipt.commandId !== command.commandId || receipt.correlationId !== command.correlationId || stableStringify(receipt.target) !== stableStringify(command.target)) {
        throw new Error("命令回执与请求的 commandId/correlationId 不一致");
      }
      for (const event of execution.events ?? []) this.appendEvent(event);
      for (const outbox of execution.outbox ?? []) this.enqueueOutbox(outbox);
      const result = this.db.prepare("UPDATE command_receipts SET receipt_json = ? WHERE idempotency_scope = ? AND idempotency_key = ? AND input_hash = ?")
        .run(JSON.stringify(receipt), command.idempotencyScope, command.idempotencyKey, inputHash);
      if (result.changes !== 1) throw new Error("命令回执完成状态未能持久化");
      return receipt;
    }).immediate;
    return transaction();
  }

  /**
   * Reconciles a pending command when its original external submission cannot
   * be queried automatically. The caller must provide an explicit, local
   * decision; the original command identity and input hash remain immutable.
   */
  reconcilePendingCommand(idempotencyScope: string, idempotencyKey: string, handler: (previous: CommandReceipt) => CommandExecution): CommandReceipt {
    const transaction = this.db.transaction(() => {
      const existing = this.getReceipt(idempotencyScope, idempotencyKey);
      if (!existing) throw new Error("待处理的命令回执不存在");
      if (existing.receipt.status !== "pending") return { ...existing.receipt, status: "duplicate" as const };
      const execution = handler(existing.receipt);
      const receipt = CommandReceiptSchema.parse(execution.receipt);
      if (receipt.commandId !== existing.receipt.commandId || receipt.correlationId !== existing.receipt.correlationId || stableStringify(receipt.target) !== stableStringify(existing.receipt.target)) throw new Error("人工恢复回执不能改变原命令身份");
      for (const event of execution.events ?? []) this.appendEvent(event);
      for (const outbox of execution.outbox ?? []) this.enqueueOutbox(outbox);
      const result = this.db.prepare("UPDATE command_receipts SET receipt_json = ? WHERE idempotency_scope = ? AND idempotency_key = ? AND input_hash = ? AND receipt_json = ?")
        .run(JSON.stringify(receipt), idempotencyScope, idempotencyKey, existing.inputHash, JSON.stringify(existing.receipt));
      if (result.changes !== 1) throw new Error("人工恢复回执未能持久化");
      return receipt;
    }).immediate;
    return transaction();
  }

  appendEvent(event: DomainEventRecord) {
    this.db.prepare(`INSERT INTO domain_events(id, aggregate_type, aggregate_id, aggregate_revision, type, payload_json, actor_type, idempotency_key, correlation_id, causation_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.id, event.aggregateType, event.aggregateId, event.aggregateRevision, event.type, JSON.stringify(event.payload), event.actorType, event.idempotencyKey ?? null, event.correlationId, event.causationId ?? null, event.occurredAt);
  }

  enqueueOutbox(outbox: OutboxRecord) {
    this.db.prepare(`INSERT INTO outbox_messages(id, kind, payload_json, idempotency_key, idempotency_scope, state, attempt, worker_id, lease_token, lease_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(idempotency_scope, idempotency_key) DO NOTHING`)
      .run(outbox.id, outbox.kind, JSON.stringify(outbox.payload), outbox.idempotencyKey, outbox.idempotencyScope, outbox.state, outbox.attempt, outbox.workerId ?? null, outbox.leaseToken ?? null, outbox.leaseExpiresAt ?? null, outbox.createdAt, outbox.updatedAt);
  }

  claimOutbox(id: string, workerId: string, now = new Date(), leaseMs = 30_000) {
    if (!workerId || !Number.isFinite(leaseMs) || leaseMs <= 0 || Number.isNaN(now.getTime())) throw new Error("无效的 outbox lease 参数");
    const timestamp = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const leaseToken = randomUUID();
    const result = this.db.prepare(`UPDATE outbox_messages SET state = 'claimed', worker_id = ?, lease_token = ?, lease_expires_at = ?, attempt = attempt + 1, updated_at = ? WHERE id = ? AND state = 'queued'`).run(workerId, leaseToken, leaseExpiresAt, timestamp, id);
    return result.changes === 1 ? leaseToken : null;
  }

  markOutboxSent(id: string, workerId: string, leaseToken: string, now = new Date()) {
    const result = this.db.prepare(`UPDATE outbox_messages SET state = 'sent', worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND state = 'claimed' AND worker_id = ? AND lease_token = ? AND lease_expires_at > ?`).run(now.toISOString(), id, workerId, leaseToken, now.toISOString());
    return result.changes === 1;
  }

  markOutboxFailed(id: string, workerId: string, leaseToken: string, retryable: boolean, now = new Date()) {
    const state = retryable ? "queued" : "failed";
    const result = this.db.prepare(`UPDATE outbox_messages SET state = ?, worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND state = 'claimed' AND worker_id = ? AND lease_token = ? AND lease_expires_at > ?`).run(state, now.toISOString(), id, workerId, leaseToken, now.toISOString());
    return result.changes === 1;
  }

  recoverExpiredOutboxClaims(now = new Date()) {
    const timestamp = now.toISOString();
    const result = this.db.prepare(`UPDATE outbox_messages SET state = 'queued', worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE state = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`).run(timestamp, timestamp);
    return result.changes;
  }

  insertArtifact(manifest: ArtifactManifest) {
    const artifact = ArtifactManifestSchema.parse(manifest);
    const workspace = this.getWorkspace(artifact.workspaceId);
    if (!workspace) throw new Error("资产所属工作区不存在");
    const resolved = resolve(workspace.rootPath, artifact.relativePath);
    const root = resolve(workspace.rootPath);
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) throw new Error("资产路径越过工作区");
    if (existsSync(root)) {
      const realRoot = realpathSync(root);
      let existingAncestor = resolved;
      while (!existsSync(existingAncestor)) {
        const parent = dirname(existingAncestor);
        if (parent === existingAncestor) break;
        existingAncestor = parent;
      }
      const realTarget = existsSync(existingAncestor) ? realpathSync(existingAncestor) : realRoot;
      if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) throw new Error("资产真实路径越过工作区");
    }
    this.db.prepare(`INSERT INTO artifacts(artifact_id, workspace_id, kind, relative_path, mime_type, content_hash, byte_size, parent_artifact_ids_json, source_revision, validation_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(artifact.artifactId, artifact.workspaceId, artifact.kind, artifact.relativePath, artifact.mimeType, artifact.contentHash, artifact.byteSize, JSON.stringify(artifact.parentArtifactIds), artifact.sourceRevision ?? null, artifact.validationStatus, nowIso());
  }

  insertArtifacts(manifests: ArtifactManifest[]) {
    const transaction = this.db.transaction(() => {
      for (const manifest of manifests) {
        const artifact = ArtifactManifestSchema.parse(manifest);
        const existing = this.getArtifact(artifact.artifactId);
        if (existing) {
          if (existing.contentHash !== artifact.contentHash || existing.relativePath !== artifact.relativePath) throw new Error(`Artifact ID 冲突：${artifact.artifactId}`);
          continue;
        }
        this.insertArtifact(artifact);
      }
    }).immediate;
    transaction();
  }

  getArtifact(id: string): ArtifactManifest | undefined {
    const row = this.db.prepare(`SELECT artifact_id AS artifactId, workspace_id AS workspaceId, kind, relative_path AS relativePath, mime_type AS mimeType, content_hash AS contentHash, byte_size AS byteSize, parent_artifact_ids_json, source_revision AS sourceRevision, validation_status AS validationStatus FROM artifacts WHERE artifact_id = ?`).get(id) as (Omit<ArtifactManifest, "parentArtifactIds"> & { parent_artifact_ids_json: string }) | undefined;
    if (!row) return undefined;
    return ArtifactManifestSchema.parse({
      schemaVersion: 1,
      artifactId: row.artifactId,
      workspaceId: row.workspaceId,
      kind: row.kind,
      relativePath: row.relativePath,
      mimeType: row.mimeType,
      contentHash: row.contentHash,
      byteSize: row.byteSize,
      parentArtifactIds: parseJson(row.parent_artifact_ids_json, "artifact parents"),
      sourceRevision: row.sourceRevision ?? undefined,
      validationStatus: row.validationStatus,
    });
  }

  listArtifacts(workspaceId: string) {
    const rows = this.db.prepare("SELECT artifact_id AS artifactId FROM artifacts WHERE workspace_id = ? ORDER BY created_at DESC, artifact_id").all(workspaceId) as Array<{ artifactId: string }>;
    return rows.flatMap((row) => {
      const artifact = this.getArtifact(row.artifactId);
      return artifact ? [artifact] : [];
    });
  }

  insertJob(job: JobRecord) {
    const value = JobRecordSchema.parse(job);
    const stored = toStoredJob(value);
    this.db.prepare(`INSERT INTO jobs(id, kind, input_hash, state, attempt, idempotency_key, idempotency_scope, provider_key, external_job_id, worker_id, lease_token, lease_expires_at, heartbeat_at, retry_after, checkpoint_json, source_run_id, correlation_id, artifact_ids_json, last_error_json, created_at, updated_at) VALUES (@id, @kind, @inputHash, @state, @attempt, @idempotencyKey, @idempotencyScope, @providerKey, @externalJobId, @workerId, @leaseToken, @leaseExpiresAt, @heartbeatAt, @retryAfter, @checkpointJson, @sourceRunId, @correlationId, @artifactIdsJson, @lastErrorJson, @createdAt, @updatedAt)`).run(stored);
  }

  getJob(id: string) {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? fromStoredJob(row) : undefined;
  }

  listJobsForWorkspace(workspaceId: string, kind?: string) {
    const rows = kind
      ? this.db.prepare("SELECT * FROM jobs WHERE idempotency_scope = ? AND kind = ? ORDER BY updated_at DESC, id DESC").all(workspaceId, kind) as Array<Record<string, unknown>>
      : this.db.prepare("SELECT * FROM jobs WHERE idempotency_scope = ? ORDER BY updated_at DESC, id DESC").all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map((row) => fromStoredJob(row));
  }

  claimJob(id: string, workerId: string, now = new Date(), leaseMs = 30_000) {
    if (!workerId || !Number.isFinite(leaseMs) || leaseMs <= 0 || Number.isNaN(now.getTime())) throw new Error("无效的 worker lease 参数");
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const timestamp = now.toISOString();
    const leaseToken = randomUUID();
    const result = this.db.prepare(`UPDATE jobs SET state = 'claimed', attempt = attempt + 1, worker_id = ?, lease_token = ?, lease_expires_at = ?, heartbeat_at = ?, retry_after = NULL, last_error_json = NULL, updated_at = ? WHERE id = ? AND state IN ('queued', 'retry_wait') AND (retry_after IS NULL OR retry_after <= ?)`)
      .run(workerId, leaseToken, leaseExpiresAt, timestamp, timestamp, id, timestamp);
    return result.changes === 1 ? leaseToken : null;
  }

  heartbeatJob(id: string, workerId: string, leaseToken: string, now = new Date(), leaseMs = 30_000) {
    if (!workerId || !leaseToken || !Number.isFinite(leaseMs) || leaseMs <= 0 || Number.isNaN(now.getTime())) throw new Error("无效的 worker heartbeat 参数");
    const timestamp = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const result = this.db.prepare(`UPDATE jobs SET state = CASE WHEN state = 'claimed' THEN 'running' ELSE state END, lease_expires_at = ?, heartbeat_at = ?, updated_at = ? WHERE id = ? AND worker_id = ? AND lease_token = ? AND state IN ('claimed', 'running') AND lease_expires_at > ?`).run(leaseExpiresAt, timestamp, timestamp, id, workerId, leaseToken, timestamp);
    return result.changes === 1;
  }

  checkpointActiveJob(id: string, workerId: string, leaseToken: string, patch: Pick<Partial<JobRecord>, "externalJobId" | "artifactIds" | "checkpoint">, now = new Date()) {
    if (!workerId || !leaseToken || Number.isNaN(now.getTime())) throw new Error("无效的 active job checkpoint 参数");
    const current = this.getJob(id);
    if (!current || !["claimed", "running"].includes(current.state) || current.workerId !== workerId || current.leaseToken !== leaseToken || !current.leaseExpiresAt || current.leaseExpiresAt <= now.toISOString()) return false;
    const next = JobRecordSchema.parse({ ...current, ...patch, updatedAt: now.toISOString() });
    const stored = toStoredJob(next);
    const result = this.db.prepare(`UPDATE jobs SET checkpoint_json = @checkpointJson, external_job_id = @externalJobId, artifact_ids_json = @artifactIdsJson, updated_at = @updatedAt WHERE id = @id AND state = @state AND worker_id = @workerId AND lease_token = @leaseToken AND lease_expires_at > @now`)
      .run({ ...stored, now: now.toISOString() });
    return result.changes === 1;
  }

  transitionJob(id: string, from: JobState, to: JobState, leaseToken?: string, patch: Pick<Partial<JobRecord>, "externalJobId" | "artifactIds" | "checkpoint" | "retryAfter" | "lastError"> = {}) {
    assertJobTransition(from, to);
    const current = this.getJob(id);
    if (!current || current.state !== from) return false;
    const hasActiveLease = Boolean(current.leaseToken);
    if (hasActiveLease && (!leaseToken || current.leaseToken !== leaseToken)) return false;
    if (!hasActiveLease && leaseToken) return false;
    if (to === "running" && !hasActiveLease) throw new Error("任务进入 running 前必须先取得 worker lease");
    const clearsLease = ["retry_wait", "succeeded", "cancelled", "timed_out", "submission_unknown", "needs_attention", "failed"].includes(to);
    const next = JobRecordSchema.parse({
      ...current,
      ...patch,
      state: to,
      ...(clearsLease ? { workerId: undefined, leaseToken: undefined, leaseExpiresAt: undefined, heartbeatAt: undefined } : {}),
      updatedAt: nowIso(),
    });
    const stored = toStoredJob(next);
    const result = this.db.prepare(`UPDATE jobs SET state = @state, worker_id = @workerId, lease_token = @leaseToken, lease_expires_at = @leaseExpiresAt, heartbeat_at = @heartbeatAt, retry_after = @retryAfter, checkpoint_json = @checkpointJson, external_job_id = @externalJobId, artifact_ids_json = @artifactIdsJson, last_error_json = @lastErrorJson, updated_at = @updatedAt WHERE id = @id AND state = @from AND ((@whereLeaseToken IS NOT NULL AND lease_token = @whereLeaseToken AND lease_expires_at > @now) OR (@whereLeaseToken IS NULL AND lease_token IS NULL))`).run({ ...stored, from, whereLeaseToken: current.leaseToken ?? null, now: new Date().toISOString() });
    return result.changes === 1;
  }

  recoverExpiredLeases(now = new Date()) {
    const timestamp = now.toISOString();
    const result = this.db.prepare(`UPDATE jobs SET state = CASE WHEN external_job_id IS NOT NULL THEN 'needs_attention' WHEN json_extract(checkpoint_json, '$.stage') = 'submitting' THEN 'submission_unknown' ELSE 'queued' END, worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ? WHERE state IN ('claimed', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`).run(timestamp, timestamp);
    return result.changes;
  }

  checkpoint() {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  async backup(destinationPath: string) {
    return this.db.backup(destinationPath);
  }
}

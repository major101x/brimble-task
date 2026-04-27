import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Response } from 'express';
import { execFile, spawn } from 'child_process';
import db from './database';

export interface Deployment {
  id: string;
  name: string;
  source: string;
  status: 'pending' | 'building' | 'deploying' | 'running' | 'failed';
  image_tag: string | null;
  url: string | null;
  created_at: string;
}

@Injectable()
export class DeploymentsService {
  private logStreams = new Map<string, Response[]>();
  private logBuffer = new Map<string, string[]>();

  findAll(): Deployment[] {
    return db
      .prepare('SELECT * FROM deployments ORDER BY created_at DESC')
      .all() as Deployment[];
  }

  findOne(id: string): Deployment | null {
    return db
      .prepare('SELECT * FROM deployments WHERE id = ?')
      .get(id) as Deployment | null;
  }

  create(name: string, source: string): Deployment {
    const deployment: Deployment = {
      id: randomUUID(),
      name,
      source,
      status: 'pending',
      image_tag: null,
      url: null,
      created_at: new Date().toISOString(),
    };

    db.prepare(
      `
      INSERT INTO deployments (id, name, source, status, image_tag, url, created_at)
      VALUES (@id, @name, @source, @status, @image_tag, @url, @created_at)
    `,
    ).run(deployment);

    // Kick off the pipeline without blocking the HTTP response.
    // The client gets the deployment record immediately while the
    // build runs in the background.
    void this.runPipeline(deployment);

    return deployment;
  }

  addLogStream(id: string, res: Response): void {
    // Replay buffered lines so late-connecting clients catch up.
    for (const line of this.logBuffer.get(id) ?? []) {
      res.write(`data: ${JSON.stringify({ line })}\n\n`);
    }
    if (!this.logStreams.has(id)) {
      this.logStreams.set(id, []);
    }
    this.logStreams.get(id)!.push(res);
  }

  // Remove an SSE client when they disconnect.
  removeLogStream(id: string, res: Response): void {
    const streams = this.logStreams.get(id) ?? [];
    this.logStreams.set(
      id,
      streams.filter((s) => s !== res),
    );
  }

  private pushLog(id: string, line: string): void {
    if (!this.logBuffer.has(id)) this.logBuffer.set(id, []);
    this.logBuffer.get(id)!.push(line);
    const streams = this.logStreams.get(id) ?? [];
    for (const res of streams) {
      res.write(`data: ${JSON.stringify({ line })}\n\n`);
    }
  }

  private updateStatus(id: string, status: Deployment['status']): void {
    db.prepare('UPDATE deployments SET status = ? WHERE id = ?').run(
      status,
      id,
    );
    this.pushLog(id, `[status] ${status}`);
  }

  private updateImageTag(id: string, imageTag: string): void {
    db.prepare('UPDATE deployments SET image_tag = ? WHERE id = ?').run(
      imageTag,
      id,
    );
  }

  private updateUrl(id: string, url: string): void {
    db.prepare('UPDATE deployments SET url = ? WHERE id = ?').run(url, id);
  }

  private async runPipeline(deployment: Deployment): Promise<void> {
    const { id, source } = deployment;
    const imageTag = `deployment-${id}`;
    const isGitUrl = /^https?:\/\/|^git@/.test(source);
    let cloneDir: string | null = null;

    try {
      // Phase 1: Build
      this.updateStatus(id, 'building');

      let buildSource = source;
      if (isGitUrl) {
        cloneDir = mkdtempSync(join(tmpdir(), 'deploy-'));
        this.pushLog(id, `[clone] ${source}`);
        await this.cloneRepo(id, source, cloneDir);
        buildSource = cloneDir;
      }

      await this.buildImage(id, buildSource, imageTag);
      this.updateImageTag(id, imageTag);

      // Phase 2: Deploy
      this.updateStatus(id, 'deploying');
      await this.runContainer(id, imageTag);
      const url = `http://localhost/deploy/${id}`;
      this.updateUrl(id, url);

      // Phase 3: Update Caddy routing
      await this.updateCaddyRoute(id);

      this.updateStatus(id, 'running');
    } catch (err) {
      this.pushLog(id, `[error] ${(err as Error).message}`);
      this.updateStatus(id, 'failed');
    } finally {
      if (cloneDir) rmSync(cloneDir, { recursive: true, force: true });
    }
  }

  private cloneRepo(id: string, url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = execFile('git', ['clone', '--depth', '1', url, dest]);

      proc.stdout?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) this.pushLog(id, line);
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) this.pushLog(id, line);
      });

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git clone exited with code ${code}`));
      });
    });
  }

  private buildImage(
    id: string,
    source: string,
    imageTag: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        BUILDKIT_HOST:
          process.env.BUILDKIT_HOST ?? 'docker-container://buildkit',
      };

      // Railpack handles exporting the image to Docker internally via the
      // BuildKit daemon — no `docker load` needed. Both stdout and stderr
      // carry human-readable progress we can stream directly to the client.
      const railpack = spawn(
        'railpack',
        ['build', '--name', imageTag, source],
        { env },
      );

      const logChunk = (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) this.pushLog(id, line);
      };

      railpack.stdout.on('data', logChunk);
      railpack.stderr.on('data', logChunk);

      railpack.on('error', (err) => reject(err));
      railpack.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Railpack exited with code ${code}`));
      });
    });
  }

  private runContainer(id: string, imageTag: string): Promise<number> {
    return new Promise((resolve, reject) => {
      // Pick a port in a range that won't collide with our core services.
      // In a real system you'd track allocated ports in the database.
      const port = 4100 + Math.floor(Math.random() * 900);

      const proc = execFile('docker', [
        'run',
        '-d',
        '--name',
        `deployment-${id}`,
        '--network',
        'brimble-task_app-network',
        '-p',
        `${port}:3000`,
        imageTag,
      ]);

      proc.on('close', (code) => {
        if (code === 0) resolve(port);
        else reject(new Error(`docker run exited with code ${code}`));
      });
    });
  }

  private async updateCaddyRoute(id: string): Promise<void> {
    const headers = { 'Content-Type': 'application/json', Origin: 'http://caddy:2019' };
    const base = 'http://caddy:2019/config/apps/http/servers/srv0/routes';

    const existing = await fetch(base, { headers }).then((r) => r.json());

    const newRoute = {
      match: [{ path: [`/deploy/${id}`, `/deploy/${id}/*`] }],
      handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `deployment-${id}:3000` }] }],
    };

    // Prepend so the deployment route is evaluated before the frontend catch-all.
    const res = await fetch(base, {
      method: 'PATCH',
      headers,
      body: JSON.stringify([newRoute, ...existing]),
    });

    if (!res.ok) throw new Error(`Caddy admin API returned ${res.status}`);
  }
}

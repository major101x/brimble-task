import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Response } from 'express';
import { execFile } from 'child_process';
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
  // In-memory map of deployment ID to list of SSE response objects.
  // When a build produces a log line, we iterate this map and push
  // to every connected client watching that deployment.
  private logStreams = new Map<string, Response[]>();

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

  // Register an SSE client for a specific deployment.
  addLogStream(id: string, res: Response): void {
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

  // Push a log line to every connected SSE client for this deployment.
  private pushLog(id: string, line: string): void {
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

    try {
      // Phase 1: Build
      this.updateStatus(id, 'building');
      await this.buildImage(id, source, imageTag);
      this.updateImageTag(id, imageTag);

      // Phase 2: Deploy
      this.updateStatus(id, 'deploying');
      const port = await this.runContainer(id, imageTag);
      const url = `http://localhost/deploy/${id}`;
      this.updateUrl(id, url);

      // Phase 3: Update Caddy routing
      await this.updateCaddyRoute(id, port);

      this.updateStatus(id, 'running');
    } catch (err) {
      this.pushLog(id, `[error] ${(err as Error).message}`);
      this.updateStatus(id, 'failed');
    }
  }

  private buildImage(
    id: string,
    source: string,
    imageTag: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // We need BuildKit running for Railpack. The BUILDKIT_HOST env var
      // tells Railpack where to find the BuildKit daemon.
      const env = {
        ...process.env,
        BUILDKIT_HOST:
          process.env.BUILDKIT_HOST ?? 'docker-container://buildkit',
      };

      const proc = execFile('railpack', ['build', '--name', imageTag, source], {
        env,
      });

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

  private updateCaddyRoute(id: string, port: number): Promise<void> {
    // Caddy exposes an admin API on port 2019 that lets you add routes
    // at runtime without restarting or reloading the entire config.
    // We use this to dynamically register a reverse proxy route for each deployment.
    return fetch(`http://caddy:2019/config/apps/http/servers/srv0/routes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        match: [{ path: [`/deploy/${id}/*`] }],
        handle: [
          {
            handler: 'reverse_proxy',
            upstreams: [{ dial: `backend:${port}` }],
          },
        ],
      }),
    }).then((res) => {
      if (!res.ok) throw new Error(`Caddy admin API returned ${res.status}`);
    });
  }
}

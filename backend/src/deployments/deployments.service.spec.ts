jest.mock('./database');

import { __resetRows } from './__mocks__/database';
import { DeploymentsService } from './deployments.service';
import type { Response } from 'express';

function mockRes() {
  return { write: jest.fn(), on: jest.fn() } as unknown as Response;
}

describe('DeploymentsService', () => {
  let service: DeploymentsService;

  beforeEach(() => {
    __resetRows();
    service = new DeploymentsService();
    // Prevent the background pipeline from spawning real processes.
    jest
      .spyOn(service as unknown as { runPipeline: () => Promise<void> }, 'runPipeline')
      .mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('create / findAll / findOne', () => {
    it('persists a deployment and returns it from findAll and findOne', () => {
      const created = service.create('my-app', 'https://github.com/x/y');

      expect(created.name).toBe('my-app');
      expect(created.source).toBe('https://github.com/x/y');
      expect(created.status).toBe('pending');
      expect(created.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      const all = service.findAll();
      expect(all.some((d) => d.id === created.id)).toBe(true);

      const found = service.findOne(created.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('my-app');
    });

    it('returns null for an unknown id', () => {
      expect(service.findOne('does-not-exist')).toBeNull();
    });

    it('orders results by created_at descending', async () => {
      service.create('first', 'src');
      // Small delay so created_at timestamps differ.
      await new Promise((r) => setTimeout(r, 5));
      service.create('second', 'src');

      const all = service.findAll();
      const names = all.map((d) => d.name);
      expect(names.indexOf('second')).toBeLessThan(names.indexOf('first'));
    });
  });

  describe('log buffer and SSE streaming', () => {
    it('replays buffered lines to a client that connects after the build', () => {
      const deployment = service.create('app', 'src');
      const id = deployment.id;

      // Simulate pipeline pushing log lines before any client is connected.
      (service as unknown as { pushLog(id: string, line: string): void }).pushLog(
        id,
        '[status] building',
      );
      (service as unknown as { pushLog(id: string, line: string): void }).pushLog(
        id,
        '[status] failed',
      );

      // Client connects late — should receive both buffered lines.
      const res = mockRes();
      service.addLogStream(id, res);

      expect(res.write).toHaveBeenCalledTimes(2);
      expect(res.write).toHaveBeenNthCalledWith(
        1,
        `data: ${JSON.stringify({ line: '[status] building' })}\n\n`,
      );
      expect(res.write).toHaveBeenNthCalledWith(
        2,
        `data: ${JSON.stringify({ line: '[status] failed' })}\n\n`,
      );
    });

    it('broadcasts new lines to all connected clients', () => {
      const { id } = service.create('app', 'src');
      const res1 = mockRes();
      const res2 = mockRes();

      service.addLogStream(id, res1);
      service.addLogStream(id, res2);

      (service as unknown as { pushLog(id: string, line: string): void }).pushLog(
        id,
        'hello',
      );

      expect(res1.write).toHaveBeenLastCalledWith(
        `data: ${JSON.stringify({ line: 'hello' })}\n\n`,
      );
      expect(res2.write).toHaveBeenLastCalledWith(
        `data: ${JSON.stringify({ line: 'hello' })}\n\n`,
      );
    });

    it('stops sending to a client after removeLogStream', () => {
      const { id } = service.create('app', 'src');
      const res = mockRes();

      service.addLogStream(id, res);
      service.removeLogStream(id, res);

      (service as unknown as { pushLog(id: string, line: string): void }).pushLog(
        id,
        'should not arrive',
      );

      // Only the replay writes (none, buffer was empty) — nothing after removal.
      expect(res.write).not.toHaveBeenCalledWith(
        `data: ${JSON.stringify({ line: 'should not arrive' })}\n\n`,
      );
    });
  });
});

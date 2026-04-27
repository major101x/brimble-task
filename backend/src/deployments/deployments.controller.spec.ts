jest.mock('./database');

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as http from 'http';
import request from 'supertest';
import { DeploymentsController } from './deployments.controller';
import { DeploymentsService } from './deployments.service';
import type { Deployment } from './deployments.service';

const DEPLOYMENT: Deployment = {
  id: 'abc-123',
  name: 'test-app',
  source: 'https://github.com/x/y',
  status: 'pending',
  image_tag: null,
  url: null,
  created_at: new Date().toISOString(),
};

const mockService = {
  findAll: jest.fn().mockReturnValue([DEPLOYMENT]),
  findOne: jest.fn().mockReturnValue(DEPLOYMENT),
  create: jest.fn().mockReturnValue(DEPLOYMENT),
  addLogStream: jest.fn(),
  removeLogStream: jest.fn(),
};

describe('DeploymentsController (HTTP)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DeploymentsController],
      providers: [{ provide: DeploymentsService, useValue: mockService }],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it('GET /deployments → 200 with array', async () => {
    const { body } = (await request(app.getHttpServer() as http.Server)
      .get('/deployments')
      .expect(200)) as { body: Deployment[] };

    expect(Array.isArray(body)).toBe(true);
    expect(body[0].id).toBe('abc-123');
  });

  it('GET /deployments/:id → 200 with deployment', async () => {
    const { body } = (await request(app.getHttpServer() as http.Server)
      .get('/deployments/abc-123')
      .expect(200)) as { body: Deployment };

    expect(body.id).toBe('abc-123');
    expect(body.name).toBe('test-app');
  });

  it('POST /deployments → 201 with new deployment', async () => {
    const { body } = (await request(app.getHttpServer() as http.Server)
      .post('/deployments')
      .send({ name: 'test-app', source: 'https://github.com/x/y' })
      .expect(201)) as { body: Deployment };

    expect(body.id).toBe('abc-123');
    expect(mockService.create).toHaveBeenCalledWith(
      'test-app',
      'https://github.com/x/y',
    );
  });
});

import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Res,
  HttpCode,
} from '@nestjs/common';
import type { Response } from 'express';
import { DeploymentsService } from './deployments.service';

@Controller('deployments')
export class DeploymentsController {
  constructor(private readonly deploymentsService: DeploymentsService) {}

  // GET /api/deployments
  // Returns all deployments ordered by creation date descending.
  @Get()
  findAll() {
    return this.deploymentsService.findAll();
  }

  // GET /api/deployments/:id
  // Returns a single deployment by ID.
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.deploymentsService.findOne(id);
  }

  // POST /api/deployments
  // Creates a new deployment and immediately kicks off the build pipeline.
  // Returns 201 with the deployment record — the pipeline runs in the background.
  @Post()
  @HttpCode(201)
  create(@Body() body: { name: string; source: string }) {
    return this.deploymentsService.create(body.name, body.source);
  }

  // GET /api/deployments/:id/logs
  // This is the SSE endpoint. The client opens this connection and keeps it open.
  // The server pushes log lines down it as the build pipeline produces them.
  @Get(':id/logs')
  streamLogs(@Param('id') id: string, @Res() res: Response) {
    // These headers are what turn a normal HTTP response into an SSE stream.
    // Content-Type: text/event-stream tells the browser this is an SSE connection.
    // Cache-Control: no-cache prevents any proxy or browser from buffering the response.
    // X-Accel-Buffering: no is specifically for Nginx (and Caddy) — it tells the
    // reverse proxy not to buffer the response before forwarding it to the client.
    // Without this header, Caddy would accumulate chunks and send them in batches,
    // which would completely destroy the "live" feel of the log stream.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Send an initial ping so the client knows the connection is alive.
    // Some browsers won't fire the 'open' event on the EventSource until
    // they receive at least one message.
    res.write(`data: ${JSON.stringify({ line: '[connected]' })}\n\n`);

    // Register this response object with the service so it receives log lines.
    this.deploymentsService.addLogStream(id, res);

    // When the client closes the connection (navigates away, closes the tab,
    // or the network drops), we remove their response from the map.
    // If we didn't do this, the map would accumulate dead response objects
    // forever, and pushLog would try to write to closed connections — causing errors.
    res.on('close', () => {
      this.deploymentsService.removeLogStream(id, res);
    });
  }
}

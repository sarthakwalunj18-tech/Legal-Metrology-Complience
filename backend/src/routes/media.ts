import { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { verifyMediaToken } from "../lib/media-signing.js";
import { StorageService } from "../services/storage.service.js";
import { UnauthenticatedError, NotFoundError } from "../lib/errors.js";

interface MediaQuery {
  token?: string;
  path?: string;
}

export const mediaRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get(
    "/media/redirect",
    async (request: FastifyRequest<{ Querystring: MediaQuery }>, reply) => {
      const { path } = request.query;
      if (!path) {
        throw new UnauthenticatedError("Missing media path");
      }

      const signedUrl = await StorageService.getSignedUrl(path);
      if (!signedUrl) {
        throw new NotFoundError("Media not found");
      }

      return reply.redirect(signedUrl);
    },
  );

  fastify.get(
    "/media/:contentType",
    async (
      request: FastifyRequest<{ Params: { contentType: string }; Querystring: MediaQuery }>,
      reply,
    ) => {
      const { token } = request.query;
      if (!token) {
        throw new UnauthenticatedError("Missing media token");
      }

      const payload = verifyMediaToken(token);
      if (!payload) {
        throw new UnauthenticatedError("Invalid or expired media token");
      }

      try {
        const { buffer, contentType, size } = await StorageService.streamFile(payload.path);
        reply
          .header("Content-Type", contentType)
          .header("Content-Length", size.toString())
          .header("Cache-Control", "private, max-age=0, no-cache")
          .header("X-Request-Id", request.id);
        return reply.send(buffer);
      } catch (error) {
        throw new NotFoundError("Media not found");
      }
    },
  );
};

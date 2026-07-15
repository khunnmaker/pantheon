-- Apollo event visibility: gate private-event title/note to the owner + the CEO (role
-- 'supervisor' only); 'public' events show details to everyone. Additive only — existing rows
-- correctly become 'private' (today's only behavior) via the column default.

ALTER TABLE "ApolloEvent" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'private';

-- Apollo event recurrence v1: a recurring rule on personal events, expanded server-side (mirrors
-- ApolloTask's rule vocabulary — see recurrence.ts). Additive only; existing rows keep NULL rule /
-- NULL until / empty skipDates and so stay single-occurrence with today's exact behavior.
-- skipDates holds 'YYYY-MM-DD' occurrence dates the owner deleted individually via the skip route;
-- recurrenceUntil (inclusive) caps the series (NULL = forever).
ALTER TABLE "ApolloEvent" ADD COLUMN "recurrenceRule" JSONB;
ALTER TABLE "ApolloEvent" ADD COLUMN "recurrenceUntil" DATE;
ALTER TABLE "ApolloEvent" ADD COLUMN "skipDates" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

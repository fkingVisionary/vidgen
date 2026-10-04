-- Saved progress of long jobs so retries resume instead of repeating paid provider calls.
ALTER TABLE "jobs" ADD COLUMN "checkpoint" JSONB;

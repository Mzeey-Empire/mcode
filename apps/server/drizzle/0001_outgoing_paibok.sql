PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_provider_model_cache` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`models_json` text NOT NULL,
	`fetched_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`model_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_provider_model_cache`("provider_id", "models_json", "fetched_at", "model_count") SELECT "provider_id", "models_json", "fetched_at", "model_count" FROM `provider_model_cache`;--> statement-breakpoint
DROP TABLE `provider_model_cache`;--> statement-breakpoint
ALTER TABLE `__new_provider_model_cache` RENAME TO `provider_model_cache`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
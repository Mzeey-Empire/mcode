CREATE TABLE `provider_model_sightings` (
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`acknowledged_at` text,
	PRIMARY KEY(`provider_id`, `model_id`)
);

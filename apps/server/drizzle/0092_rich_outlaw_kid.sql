CREATE TABLE IF NOT EXISTS `mcode_schema_compatibility` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`floor_when` integer NOT NULL,
	`raised_by` text NOT NULL,
	CONSTRAINT "mcode_schema_compatibility_single_row" CHECK("mcode_schema_compatibility"."id" = 1)
);
--> statement-breakpoint
INSERT INTO `mcode_schema_compatibility` (`id`, `floor_when`, `raised_by`) VALUES (1, 1792188588184, '0091_happy_baron_strucker') ON CONFLICT(`id`) DO UPDATE SET `floor_when` = max(`floor_when`, excluded.`floor_when`), `raised_by` = CASE WHEN excluded.`floor_when` > `floor_when` THEN excluded.`raised_by` ELSE `raised_by` END;

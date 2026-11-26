ALTER TABLE `workspaces` ADD `moved_out_at` text;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `retain_until` text;
--> statement-breakpoint
INSERT INTO `mcode_schema_compatibility` (`id`, `floor_when`, `raised_by`) VALUES (1, 1795714787764, '0113_curious_the_twelve') ON CONFLICT(`id`) DO UPDATE SET `floor_when` = max(`floor_when`, excluded.`floor_when`), `raised_by` = CASE WHEN excluded.`floor_when` > `floor_when` THEN excluded.`raised_by` ELSE `raised_by` END;

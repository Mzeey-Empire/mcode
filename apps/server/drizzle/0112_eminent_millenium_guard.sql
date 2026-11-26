ALTER TABLE `workspaces` ADD `kind` text DEFAULT 'project' NOT NULL;
--> statement-breakpoint
INSERT INTO `mcode_schema_compatibility` (`id`, `floor_when`, `raised_by`) VALUES (1, 1795599249369, '0112_eminent_millenium_guard') ON CONFLICT(`id`) DO UPDATE SET `floor_when` = max(`floor_when`, excluded.`floor_when`), `raised_by` = CASE WHEN excluded.`floor_when` > `floor_when` THEN excluded.`raised_by` ELSE `raised_by` END;

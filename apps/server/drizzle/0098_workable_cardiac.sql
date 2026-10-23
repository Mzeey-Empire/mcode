ALTER TABLE `threads` ADD `fast_mode` integer;--> statement-breakpoint
UPDATE `threads` SET `fast_mode` = `codex_fast_mode` WHERE `codex_fast_mode` IS NOT NULL;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `threads_codex_fast_mode_insert_sync` AFTER INSERT ON `threads`
WHEN NEW.`fast_mode` IS NULL AND NEW.`codex_fast_mode` IS NOT NULL
BEGIN
  UPDATE `threads` SET `fast_mode` = NEW.`codex_fast_mode` WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `threads_codex_fast_mode_update_sync` AFTER UPDATE OF `codex_fast_mode` ON `threads`
WHEN NEW.`fast_mode` IS NOT NEW.`codex_fast_mode`
BEGIN
  UPDATE `threads` SET `fast_mode` = NEW.`codex_fast_mode` WHERE `id` = NEW.`id`;
END;

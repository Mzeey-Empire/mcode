import {
  Play,
  Square,
  FlaskConical,
  Download,
  Hammer,
  Zap,
  Terminal,
  Bug,
  Package,
  Rocket,
  RefreshCw,
  Check,
  Code,
  Database,
  Globe,
  Shield,
  type LucideIcon,
} from "lucide-react";
import type { ActionIcon } from "@mcode/contracts";

/** Maps the 16 curated ActionIcon names to their Lucide components. */
const ICON_MAP: Record<ActionIcon, LucideIcon> = {
  play: Play,
  square: Square,
  "flask-conical": FlaskConical,
  download: Download,
  hammer: Hammer,
  zap: Zap,
  terminal: Terminal,
  bug: Bug,
  package: Package,
  rocket: Rocket,
  "refresh-cw": RefreshCw,
  check: Check,
  code: Code,
  database: Database,
  globe: Globe,
  shield: Shield,
};

/**
 * Returns the Lucide icon component for a given ActionIcon name.
 * Falls back to the Play icon when the name is not in the curated set.
 */
export function getLucideIcon(icon: ActionIcon): LucideIcon {
  return ICON_MAP[icon] ?? Play;
}

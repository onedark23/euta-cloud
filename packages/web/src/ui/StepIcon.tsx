// Step action → lucide icon (SPEC_UI-디자인-시스템 "글꼴 · 아이콘"). Replaces the engine's emoji
// (describeStep().icon), which stays for reports and MCP text. Same map as the app's ui/StepIcon.
import {
  ArrowUpDown,
  ChevronsUpDown,
  CircleCheck,
  CircleQuestionMark,
  Download,
  Folder,
  Globe,
  Hand,
  Hourglass,
  Image,
  Keyboard,
  MousePointer2,
  MousePointerClick,
  Pointer,
  Ruler,
  Sparkles,
  Square,
  SquareCheck,
  Upload,
  UserCheck,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  goto: Globe,
  click: MousePointerClick,
  dblclick: MousePointerClick,
  hover: MousePointer2,
  tap: Pointer,
  fill: Keyboard,
  type: Keyboard,
  press: Keyboard,
  select: ChevronsUpDown,
  check: SquareCheck,
  uncheck: Square,
  upload: Upload,
  scroll: ArrowUpDown,
  drag: Hand,
  wait: Hourglass,
  expect: CircleCheck,
  measure: Ruler,
  expectDownload: Download,
  visual: Image,
  group: Folder,
  ai: Sparkles,
  manual: UserCheck,
};

export function StepIcon({ action }: { action?: string }) {
  const Icon = (action && ICONS[action]) || CircleQuestionMark;
  return (
    <span className="step-icon" data-action={action ?? 'unknown'} aria-hidden="true">
      <Icon size={16} />
    </span>
  );
}

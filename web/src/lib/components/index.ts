/**
 * The component library. Components draw the boards and own the interactions
 * that belong to them (focus, keys, copy, toggles); screens compose them and
 * call the layers below. Colours come from the semantic tokens only.
 */
export { default as AppRail } from './AppRail.svelte';
export { default as Avatar } from './Avatar.svelte';
export { default as Banner } from './Banner.svelte';
export { default as Button } from './Button.svelte';
export { default as Card } from './Card.svelte';
export { default as Checkbox } from './Checkbox.svelte';
export { default as CodeBlock } from './CodeBlock.svelte';
export { default as Dialog } from './Dialog.svelte';
export { default as EmptyState } from './EmptyState.svelte';
export { default as Field } from './Field.svelte';
export { default as FileList } from './FileList.svelte';
export { default as FileRow } from './FileRow.svelte';
export { default as FileTile } from './FileTile.svelte';
export { default as HealthStatus } from './HealthStatus.svelte';
export { default as Icon } from './Icon.svelte';
export { default as Logo } from './Logo.svelte';
export { default as Menu } from './Menu.svelte';
export { default as NavItem } from './NavItem.svelte';
export { default as NavSection } from './NavSection.svelte';
export { default as PasswordField } from './PasswordField.svelte';
export { default as ProgressBar } from './ProgressBar.svelte';
export { default as RadioCard } from './RadioCard.svelte';
export { default as RadioGroup } from './RadioGroup.svelte';
export { default as SearchField } from './SearchField.svelte';
export { default as SegmentedControl } from './SegmentedControl.svelte';
export { default as Select } from './Select.svelte';
export { default as Sidebar } from './Sidebar.svelte';
export { default as SidePanel } from './SidePanel.svelte';
export { default as Stepper } from './Stepper.svelte';
export { default as StrengthMeter } from './StrengthMeter.svelte';
export { default as Switch } from './Switch.svelte';
export { default as Tabs } from './Tabs.svelte';
export { default as Tag } from './Tag.svelte';
export { default as TextInput } from './TextInput.svelte';
export { default as ThemeToggle } from './ThemeToggle.svelte';
export { default as Toast } from './Toast.svelte';
export { default as ToastStack } from './ToastStack.svelte';
export { default as TopBar } from './TopBar.svelte';

export { copyText, type CopyResult } from './clipboard';
export { FILE_KINDS, type FileKind } from './fileKinds';
export { ICONS, type IconName } from './icons';
export type { FieldControl } from './Field.svelte';
export type { FileTag } from './FileRow.svelte';
export type { MenuItem, TriggerAttrs } from './Menu.svelte';
export type { Segment as ProgressSegment } from './ProgressBar.svelte';
export type { Segment } from './SegmentedControl.svelte';
export type { SelectOption } from './Select.svelte';
export type { Step } from './Stepper.svelte';
export type { Tab } from './Tabs.svelte';

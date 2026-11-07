export const RADIO_GROUP = Symbol('radio-group');

/** What a RadioGroup shares with the RadioCard options inside it. */
export interface RadioGroupContext {
	readonly value: string;
	select(value: string): void;
}

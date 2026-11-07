/** What the worker's refusals mean, said to the person who typed. */

export interface InputRefusal {
	name: string;
	problem?: string;
	detail?: string;
	message: string;
}

export function describeInputError(e: InputRefusal): string {
	if (e.name !== 'FormulaInputError') return e.message || 'That did not work.';
	const d = e.detail ?? '';
	switch (e.problem) {
		case 'syntax':
			return d ? `That formula could not be read: ${d}.` : 'That formula could not be read.';
		case 'unsupported':
			return `${d || 'A function in it'} is not calculated by this app, so the formula was not entered.`;
		case 'arity':
			return `${d} was given the wrong number of arguments.`;
		case 'sheet':
			if (d === 'name in use') return 'Another sheet already has that name.';
			if (d === 'a workbook keeps one sheet') return 'A workbook keeps at least one sheet.';
			if (d === 'not a valid sheet name')
				return 'Sheet names have 1 to 31 characters, none of [ ] : * ? / \\, and do not start or end with an apostrophe.';
			return 'That formula refers to a sheet that does not exist.';
		case 'argument':
			return `That could not be done: the ${d || 'request'} given was out of range. Select the cells again and retry.`;
		case 'readonly':
			if (d === 'array formula')
				return 'Part of an array formula, which is kept as it was and cannot be changed here.';
			if (d === 'content would move off the sheet')
				return 'That would push cells off the edge of the sheet.';
			if (d === 'merged cells')
				return 'Ranges with merged cells cannot be sorted. Unmerge them first.';
			if (d === 'a cell that cannot be changed')
				return 'The range has cells that are kept as they were in the file and cannot be changed here.';
			return d
				? `This cell uses ${d}, which this app does not calculate. It is kept as it was and cannot be edited here.`
				: 'This cell cannot be edited here.';
	}
	return e.message;
}

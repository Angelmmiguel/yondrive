/** The open spreadsheet, off the page: a hostile file or a long recalculation stalls only this worker. */
import { expose } from './rpc';
import { SheetService } from './service';

expose(new SheetService(), self as unknown as Worker);

import { EncodedDBInterface } from '../DB/EncodedDB';
import { ProgramsDBInterface } from '../DB/ProgramsDB';
import { RecordedDBInterface } from '../DB/RecordedDB';
import { RecordedHistoryDBInterface } from '../DB/RecordedHistoryDB';
import { RulesDBInterface } from '../DB/RulesDB';
import { ServicesDBInterface } from '../DB/ServicesDB';
import Model from '../Model';

interface DBInitializationModelInterface extends Model {
    run(): Promise<void>;
}

/**
 * DB の起動処理
 */
class DBInitializationModel extends Model implements DBInitializationModelInterface {
    private servicesDB: ServicesDBInterface;
    private programsDB: ProgramsDBInterface;
    private rulesDB: RulesDBInterface;
    private recordedDB: RecordedDBInterface;
    private encodedDB: EncodedDBInterface;
    private recordedHistoryDB: RecordedHistoryDBInterface;

    constructor(
        servicesDB: ServicesDBInterface,
        programsDB: ProgramsDBInterface,
        rulesDB: RulesDBInterface,
        recordedDB: RecordedDBInterface,
        encodedDB: EncodedDBInterface,
        recordedHistoryDB: RecordedHistoryDBInterface,
    ) {
        super();

        this.servicesDB = servicesDB;
        this.programsDB = programsDB;
        this.rulesDB = rulesDB;
        this.recordedDB = recordedDB;
        this.encodedDB = encodedDB;
        this.recordedHistoryDB = recordedHistoryDB;
    }

    public async run(): Promise<void> {
        try {
            // DB table 作成
            await this.servicesDB.create();
            this.log.system.info('ServicesDB created');

            await this.programsDB.create();
            this.log.system.info('ProgramsDB created');

            await this.rulesDB.create();
            this.log.system.info('RulesDB created');

            await this.recordedDB.create();
            this.log.system.info('RecordedDB created');

            await this.encodedDB.create();
            this.log.system.info('EncodedDB created');

            await this.recordedHistoryDB.create();
            this.log.system.info('RecordedHistoryDB created');

            await this.recordedDB.removeAllRecording();
            await this.recordedDB.updateAllNullFileSize();
            await this.encodedDB.updateAllNullFileSize();
        } catch (err) {
            this.log.system.fatal('Operator init error');
            this.log.system.fatal(err);
            process.exit(1);
        }

        // 終了時に DB 接続を切断
        process.on('exit', () => { this.servicesDB.end(); });
    }
}

export { DBInitializationModelInterface, DBInitializationModel };


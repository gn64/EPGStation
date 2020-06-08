import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import { inject, injectable } from 'inversify';
import internal from 'stream';
import * as apid from '../../../../../api';
import FileUtil from '../../../../util/FileUtil';
import ProcessUtil from '../../../../util/ProcessUtil';
import IConfigFile from '../../../IConfigFile';
import IConfiguration from '../../../IConfiguration';
import ILoggerModel from '../../../ILoggerModel';
import IMirakurunClientModel from '../../../IMirakurunClientModel';
import IEncodeProcessManageModel, { CreateProcessOption } from '../../encode/IEncodeProcessManageModel';
import IHLSFileDeleterModel from '../util/IHLSFileDeleterModel';
import ILiveStreamBaseModel, { LiveStreamOption } from './ILiveStreamBaseModel';
import { LiveStreamInfo } from './IStreamBaseModel';
import StreamBaseModel from './StreamBaseModel';

@injectable()
export default abstract class LiveStreamBaseModel extends StreamBaseModel<LiveStreamOption>
    implements ILiveStreamBaseModel {
    private stream: http.IncomingMessage | null = null;
    private streamProcess: ChildProcess | null = null;
    private mirakurunClientModel: IMirakurunClientModel;

    constructor(
        @inject('IConfiguration') configure: IConfiguration,
        @inject('ILoggerModel') logger: ILoggerModel,
        @inject('IEncodeProcessManageModel') processManager: IEncodeProcessManageModel,
        @inject('IHLSFileDeleterModel') fileDeleter: IHLSFileDeleterModel,
        @inject('IMirakurunClientModel') mirakurunClientModel: IMirakurunClientModel,
    ) {
        super(configure, logger, processManager, fileDeleter);

        this.mirakurunClientModel = mirakurunClientModel;
    }

    /**
     * stream プロセス生成に必要な情報を生成する
     * @param streamId: apid.StreamId
     * @return CreateProcessOption | null プロセス生成する必要がない場合は null を返す
     */
    protected createProcessOption(streamId: apid.StreamId): CreateProcessOption | null {
        if (this.processOption === null) {
            throw new Error('ProcessOptionIsNull');
        }

        /**
         * mirakurun の stream をそのまま横流しする
         */
        if (typeof this.processOption.cmd === 'undefined') {
            return null;
        }

        let cmd = this.processOption.cmd.replace(/%FFMPEG%/g, this.config.ffmpeg);
        if (this.getStreamType() === 'LiveHLS') {
            cmd = cmd
                .replace(/%streamFileDir%/g, this.config.streamFilePath)
                .replace(/%streamNum%/g, streamId.toString(10));
        }

        return {
            input: null,
            output: this.getStreamType() === 'LiveHLS' ? `${this.config.streamFilePath}\/stream${streamId}.m3u8` : null,
            cmd: cmd,
            priority: LiveStreamBaseModel.ENCODE_PROCESS_PRIORITY,
        };
    }

    /**
     * ストリーム開始
     * @param streamId: apid.StreamId
     * @return Promise<void>
     */
    public async start(streamId: apid.StreamId): Promise<void> {
        if (this.processOption === null) {
            throw new Error('ProcessOptionIsNull');
        }

        if (this.getStreamType() === 'LiveHLS') {
            // streamFilePath の存在チェック
            try {
                await FileUtil.access(this.config.streamFilePath, fs.constants.R_OK | fs.constants.W_OK);
            } catch (err) {
                if (typeof err.code !== 'undefined' && err.code === 'ENOENT') {
                    // ディレクトリが存在しないので作成する
                    this.log.stream.info(`mkdirp: ${this.config.streamFilePath}`);
                    await FileUtil.mkdir(this.config.streamFilePath);
                } else {
                    // アクセス権に Read or Write が無い
                    this.log.stream.fatal(`dir permission error: ${this.config.streamFilePath}`);
                    this.log.stream.fatal(err);
                    throw err;
                }
            }

            // ゴミファイルを削除
            await this.fileDeleter.setOption({
                streamId: streamId,
                streamFilePath: this.config.streamFilePath,
            });
            await this.fileDeleter.deleteAllFiles();
        }

        // 放送波受信
        await this.setMirakurunStream(this.config);
        if (this.stream === null) {
            throw new Error('SetStreamError');
        }

        // エンコードプロセスの生成が必要かチェック
        const poption = this.createProcessOption(streamId);
        if (poption !== null) {
            // エンコードプロセス生成
            this.log.stream.info(`create encode process: ${poption.cmd}`);
            this.streamProcess = await this.processManager.create(poption).catch(err => {
                if (this.stream !== null) {
                    this.stream.unpipe();
                    this.stream.destroy();
                }

                this.log.stream.error(`create encode process failed: ${poption.cmd}`);
                throw err;
            });

            // process 終了にイベントを発行する
            this.streamProcess.on('exit', () => {
                this.emitExitStream();
            });
            this.streamProcess.on('error', () => {
                this.emitExitStream();
            });

            // ffmpeg debug 用ログ出力
            if (this.streamProcess.stderr !== null) {
                this.streamProcess.stderr.on('data', data => {
                    this.log.stream.debug(String(data));
                });
            }

            // パイプ処理
            if (this.streamProcess.stdin !== null) {
                this.stream.pipe(this.streamProcess.stdin);
            } else {
                await this.stop();

                throw new Error('StreamProcessStdinIsNull');
            }

            if (this.getStreamType() === 'LiveHLS') {
                // ファイル自動削除開始
                this.fileDeleter.start();
            }
        } else {
            // stream 停止処理時にイベントを発行する
            this.stream.on('close', () => {
                this.emitExitStream();
            });
            this.stream.on('end', () => {
                this.emitExitStream();
            });
            this.stream.on('error', () => {
                this.emitExitStream();
            });
        }
    }

    /**
     * 放送波受信
     * @param config: IConfigFile
     * @return Promise<void>
     */
    private async setMirakurunStream(config: IConfigFile): Promise<void> {
        if (this.processOption === null) {
            throw new Error('ProcessOptionIsNull');
        }

        const mirakurun = this.mirakurunClientModel.getClient();
        mirakurun.priority = config.streamingPriority;

        this.log.stream.info(`get mirakurun service stream: ${this.processOption.channelId}`);
        this.stream = await mirakurun
            .getServiceStream(this.processOption.channelId, true, config.streamingPriority)
            .catch(err => {
                this.stream = null;
                this.log.system.error(`get mirakurun service stream failed: ${this.processOption!.channelId}`);
                throw err;
            });
    }

    /**
     * ストリーム停止
     * @return Promise<void>
     */
    public async stop(): Promise<void> {
        if (this.stream !== null) {
            this.stream.unpipe();
            this.stream.destroy();
        }

        if (this.streamProcess !== null) {
            await ProcessUtil.kill(this.streamProcess);
        }

        if (this.getStreamType() === 'LiveHLS') {
            this.fileDeleter.stop();
            await this.fileDeleter.deleteAllFiles();
        }
    }

    /**
     * 生成したストリームを返す
     * @return internal.Readable
     */
    public getStream(): internal.Readable {
        if (this.streamProcess !== null && this.streamProcess.stdout !== null) {
            return this.streamProcess.stdout;
        } else if (this.stream !== null) {
            return this.stream;
        } else {
            throw new Error('StreamIsNull');
        }
    }

    /**
     * ストリーム情報を返す
     * @return LiveStreamInfo
     */
    public getInfo(): LiveStreamInfo {
        if (this.processOption === null) {
            throw new Error('ProcessOptionIsNull');
        }

        return {
            type: this.getStreamType(),
            channelId: this.processOption.channelId,
            isEnable: false, // TODO 実装
        };
    }

    protected abstract getStreamType(): 'LiveStream' | 'LiveHLS';
}
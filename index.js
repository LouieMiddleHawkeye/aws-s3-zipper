var assert = require("assert");
var archiver = require("archiver");
var async = require("async");
var AWS = require("aws-sdk");
var fs = require("fs");
var s3 = require("@auth0/s3");

function S3Zipper(awsConfig) {
    var self = this;
    var credentials;
    assert.ok(awsConfig, "AWS S3 options must be defined.");
    if (!awsConfig.useCredentials) {
        assert.notEqual(
            awsConfig.accessKeyId,
            undefined,
            "Requires S3 AWS Key."
        );
        assert.notEqual(
            awsConfig.secretAccessKey,
            undefined,
            "Requires S3 AWS Secret"
        );
    } else {
        assert.notEqual(
            awsConfig.profile,
            undefined,
            "Requires AWS credentials profile"
        );
        credentials = new AWS.SharedIniFileCredentials({
            profile: awsConfig.profile,
        });
    }
    assert.notEqual(awsConfig.region, undefined, "Requires AWS S3 region.");
    assert.notEqual(awsConfig.bucket, undefined, "Requires AWS S3 bucket.");

    if (credentials) {
        AWS.config.credentials = credentials;
        AWS.config.update({
            region: awsConfig.region,
        });
    } else {
        AWS.config.update({
            accessKeyId: awsConfig.accessKeyId,
            secretAccessKey: awsConfig.secretAccessKey,
            region: awsConfig.region,
        });
    }

    self.init(awsConfig);
}

S3Zipper.prototype = {
    init: function (awsConfig) {
        this.awsConfig = awsConfig;
        var self = this;
        self.s3bucket = new AWS.S3({
            params: {
                Bucket: self.awsConfig.bucket,
            },
        });
    },
    filterOutFiles: function (fileObj) {
        return fileObj;
    },
    calculateFileName: function (f, params) {
        var name = f.Key.split("/");
        name.shift();
        return !params.folderPath ? name[name.length - 1] : name.join("/");
    },

    /*
     params={
     folderName: the name of the folder within the s3 bucket
     , startKey: the key of the file you want to start after. keep null if you want to start from the first file
     , maxFileCount: an integer that caps off how many files to zip at a time
     , maxFileSize: max total size of files before they are zipped
     , recursive: option to loop through nested folders
     };
     callback = function that is called back when completed
    * */
    getFiles: function (params, callback) {
        if (arguments.length == 5) {
            //for backwards comparability
            params = {
                folderName: arguments[0],
                startKey: arguments[1],
                maxFileCount: arguments[2],
                maxFileSize: arguments[3],
                recursive: false,
            };
            callback = arguments[4];
        }

        var bucketParams = {
            Bucket: this.awsConfig.bucket /* required */,
            Delimiter: "/",
            Prefix: params.folderName + "/",
        };

        if (params.startKey) bucketParams.Marker = params.startKey;

        if (
            typeof params.maxFileCount == "function" &&
            typeof callback == "undefined"
        ) {
            callback = params.maxFileCount;
            params.maxFileCount = null;
        } else if (params.maxFileCount > 0)
            bucketParams.MaxKeys = params.maxFileCount;

        var t = this;

        var files = {};
        files.Contents = [];

        var options = {
            s3Client: this.s3bucket,
            // more options available. See API docs below.
        };
        var client = s3.createClient(options);

        var realParams = {
            s3Params: bucketParams,
            recursive: params.recursive,
        };

        var emitter = client.listObjects(realParams);
        emitter.on("data", function (data) {
            if (data && data.Contents) {
                files.Contents = files.Contents.concat(data.Contents);
            }
        });

        emitter.on("error", function (err) {
            console.error("unable to get files:", err.stack);
            callback(err);
        });

        emitter.on("end", function () {
            var data = files;
            console.log("end");
            var result = [];
            var totalSizeOfPassedFiles = 0;
            var lastScannedFile;
            for (var i = 0; i < data.Contents.length; i++) {
                var passedFile = t.filterOutFiles(data.Contents[i]);
                if (passedFile) {
                    if (
                        params.maxFileSize &&
                        params.maxFileSize < passedFile.Size
                    ) {
                        console.warn(
                            "Single file size exceeds max allowed size",
                            data.Contents[i].Size,
                            ">",
                            params.maxFileSize,
                            passedFile
                        );
                        if (result.length == 0) {
                            console.warn(
                                "Will zip large file on its own",
                                passedFile.Key
                            );
                            result.push(passedFile);
                            totalSizeOfPassedFiles += passedFile.Size;
                        } else break;
                    } else if (
                        params.maxFileSize &&
                        totalSizeOfPassedFiles + data.Contents[i].Size >
                            params.maxFileSize
                    ) {
                        console.log("Hit max size limit. Split fragment");
                        break;
                    } else {
                        result.push(passedFile);
                        totalSizeOfPassedFiles += passedFile.Size;
                    }
                }

                lastScannedFile = data.Contents[i];
            }

            callback(null, {
                files: result,
                totalFilesScanned: data.Contents.length,
                lastScannedFile: lastScannedFile,
            });
        });
    },

    /*
     params: {
        pipe : pipe stream
         , folderName: folder name to zip
         , startKey: the key of the file you want to start after. keep null if you want to start from the first file
         , maxFileCount: an integer that caps off how many files to zip at a time
         , maxFileSize: max total size of files before they are zipped
         , recursive: option to loop through nested folders
       }
       , callback : function
    */
    streamZipDataTo: function (params, callback) {
        if (!params || !params.folderName) {
            console.error("folderName required");
            return null;
        }

        var zip = new archiver.create("zip");
        if (params.pipe) zip.pipe(params.pipe);

        var t = this;

        this.getFiles(params, function (err, clearedFiles) {
            if (err) console.error(err);
            else {
                var files = clearedFiles.files;
                console.log("files", files);
                async.map(
                    files,
                    function (f, callback) {
                        t.s3bucket.getObject(
                            { Bucket: t.awsConfig.bucket, Key: f.Key },
                            function (err, data) {
                                if (err) callback(err);
                                else {
                                    var name = t.calculateFileName(f, params);

                                    if (name === "") {
                                        callback(null, f);
                                        return;
                                    } else {
                                        console.log("zipping ", name, "...");

                                        zip.append(data.Body, { name: name });
                                        callback(null, f);
                                    }
                                }
                            }
                        );
                    },
                    function (err, results) {
                        zip.manifest = results;
                        zip.on("finish", function () {
                            callback(err, {
                                zip: zip,
                                zippedFiles: results,
                                totalFilesScanned:
                                    clearedFiles.totalFilesScanned,
                                lastScannedFile: clearedFiles.lastScannedFile,
                            });
                        });
                        zip.finalize();
                    }
                );
            }
        });
    },

    uploadLocalFileToS3: function (
        localFileName,
        s3ZipFileName,
        callback,
        bucket
    ) {
        console.log("uploading ", s3ZipFileName, "...");
        var readStream = fs.createReadStream(localFileName); //tempFile

        this.s3bucket
            .upload({
                Bucket: bucket,
                Key: s3ZipFileName,
                ContentType: "application/zip",
                Body: readStream,
            })
            .on("httpUploadProgress", function (e) {
                var p = Math.round((e.loaded / e.total) * 100);
                if (p % 10 == 0) console.log("upload progress", p, "%");
            })
            .send(function (err, result) {
                readStream.close();
                if (err) callback(err);
                else {
                    console.log("upload completed.");
                    callback(null, result);
                }
            });
    },
    //all these timeouts are because streams arent done writing when they say they are

    /*
     params: {
        s3FolderName: the name of the folder within the S3 bucket
        , startKey: the key of the file you want to start after. keep null if you want to start from the first file
        , s3ZipFileName: the name of the file you to zip to and upload to S3
        , tmpDir: specifies the directory of the temporal zip file, default is node_modules/aws-s3-zipper
        , recursive: indicates to zip nested folders or not
       }
       , callback: function
    */
    zipToS3File: function (params, callback) {
        if (arguments.length == 5) {
            // for backward compatibility
            params = {
                s3FolderName: arguments[0],
                startKey: arguments[1],
                s3ZipFileName: arguments[2],
                tmpDir: arguments[3],
                recursive: false,
            };
            callback = arguments[4];
        }

        var t = this;
        params.tmpDir = params.tmpDir ? params.tmpDir + "/" : "";
        params.zipFileName = params.tmpDir + "__" + Date.now() + ".zip";

        if (params.s3ZipFileName.indexOf("/") < 0)
            params.s3ZipFileName =
                params.s3FolderName + "/" + params.s3ZipFileName;

        this.zipToFile(params, function (err, r) {
            if (r && r.zippedFiles && r.zippedFiles.length) {
                t.uploadLocalFileToS3(
                    params.zipFileName,
                    params.s3ZipFileName,
                    function (err, result) {
                        callback(null, {
                            zipFileETag: result.ETag,
                            zipFileLocation: result.Location,
                            zippedFiles: r.zippedFiles,
                        });
                        fs.unlinkSync(params.zipFileName);
                    }
                );
            } else {
                console.log("no files zipped. nothing to upload");
                fs.unlinkSync(params.zipFileName);
                callback(null, {
                    zipFileETag: null,
                    zipFileLocation: null,
                    zippedFiles: [],
                });
            }
        });
    },

    /*
     params: {
        s3FolderName: the name of the folder within the S3 bucket
        , startKey: the key of the file you want to start after. keep null if you want to start from the first file
        , s3ZipFileName: the name of the file you to zip to and upload to S3
        , maxFileCount: an integer that caps off how many files to zip at a time
        , maxFileSize: max total size of files before they are zipped
        , tmpDir: specifies the directory of the temporal zip file, default is node_modules/aws-s3-zipper
        , recursive: indicates to zip nested folders or not
     }
     , callback: function
    */
    zipToS3FileFragments: function (params, callback) {
        if (arguments.length == 7) {
            // for backward compatibility
            params = {
                s3FolderName: arguments[0],
                startKey: arguments[1],
                s3ZipFileName: arguments[2],
                maxFileCount: arguments[3],
                maxFileSize: arguments[4],
                tmpDir: arguments[5],
                recursive: false,
                folderPath:
                    typeof params.folderPath == "boolean"
                        ? params.folderPath
                        : true,
            };
            callback = arguments[6];
        }

        var t = this;
        ///local file
        params.tmpDir = params.tmpDir ? params.tmpDir + "/" : "";
        params.zipFileName = params.tmpDir + "__" + Date.now() + ".zip";

        if (params.s3ZipFileName.indexOf("/") < 0)
            params.s3ZipFileName =
                params.s3FolderName + "/" + params.s3ZipFileName;

        params.bucket = params.bucket ? params.bucket : awsConfig.bucket;

        var finalResult;

        var count = 0;
        this.zipToFileFragments(params, function (err, result) {
            if (err) callback(err);
            else {
                finalResult = result;
                if (!result || result.length == 0) callback(null, result); /// dont need to wait for uploads
            }
        }).onFileZipped = function (fragFileName, result) {
            var s3fn = params.s3ZipFileName.replace(
                ".zip",
                "_" + count + ".zip"
            );
            count++;
            uploadFrag(s3fn, fragFileName, result);
        };

        var pendingUploads = 0; // prevent race condition
        function uploadFrag(s3FragName, localFragName, result) {
            pendingUploads++;
            t.uploadLocalFileToS3(
                localFragName,
                s3FragName,
                function (err, uploadResult) {
                    if (uploadResult) {
                        result.uploadedFile = uploadResult;
                        console.log("remove temp file ", localFragName);
                        fs.unlinkSync(localFragName);
                    }
                    pendingUploads--;
                    if (pendingUploads == 0 && finalResult) {
                        callback(null, finalResult);
                    }
                },
                params.bucket
            );
        }
    },
    /*
     params={
        s3FolderName: the name of the folder within the s3 bucket
        , startKey: the key of the file you want to start after. keep null if you want to start from the first file
        , zipFileName: zip file name
        , recursive: option to loop through nested folders
     };
     callback = function that is called back when completed
     * */
    zipToFile: function (params, callback) {
        if (arguments.length == 4) {
            // for backward compatibility
            params = {
                s3FolderName: arguments[0],
                startKey: arguments[1],
                zipFileName: arguments[2],
                recursive: false,
                folderPath: params.folderPath,
            };
            callback = arguments[3];
        }

        var filestream = fs.createWriteStream(params.zipFileName);
        this.streamZipDataTo(
            {
                pipe: filestream,
                folderName: params.s3FolderName,
                startKey: params.startKey,
                maxFileCount: params.maxFileCount,
                maxFileSize: params.maxFileSize,
                recursive: params.recursive,
            },
            function (err, result) {
                setTimeout(function () {
                    callback(err, result);
                    filestream.close();
                }, 1000);
            }
        );
    },

    /*
     params: {
        s3FolderName: the name of the folder within the S3 bucket
        , startKey: the key of the file you want to start after. keep null if you want to start from the first file
        , zipFileName: the name of the file you to zip to and upload to S3
        , maxFileCount: an integer that caps off how many files to zip at a time
        , maxFileSize: max total size of files before they are zipped
        , recursive: indicates to zip nested folders or not
     }
     , callback: function
     */
    zipToFileFragments: function (params, callback) {
        if (arguments.length == 6) {
            // for backward compatibility
            params = {
                s3FolderName: arguments[0],
                startKey: arguments[1],
                s3ZipFileName: arguments[2],
                maxFileCount: arguments[3],
                maxFileSize: arguments[4],
                recursive: false,
            };
            callback = arguments[5];
        }

        var events = {
            onFileZipped: function () {},
        };

        var report = {
            results: [],
            errors: [],
            lastKey: null,
        };

        if (params.maxFileSize && params.maxFileSize < 1024)
            console.warn(
                "Max File Size is really low. This may cause no files to be zipped, maxFileSize set to ",
                params.maxFileSize
            );

        if (params.zipFileName.indexOf(".zip") < 0)
            params.zipFileName += ".zip";

        var t = this;

        function garbageCollector(fileStream, result, fragFileName) {
            setTimeout(function () {
                fileStream.close();
                if (result.zippedFiles.length == 0)
                    /// its an empty zip file get rid of it

                    fs.unlinkSync(fragFileName);
                else events.onFileZipped(fragFileName, result);
            }, 1000); /// TODO: Zip needs a bit more time to finishing writing. I'm sure there is a better way
        }

        var counter = 0;

        function recursiveLoop(startKey, fragFileName, callback) {
            var fileStream = fs.createWriteStream(fragFileName);
            t.streamZipDataTo(
                {
                    pipe: fileStream,
                    folderName: params.s3FolderName,
                    startKey: startKey,
                    maxFileCount: params.maxFileCount,
                    maxFileSize: params.maxFileSize,
                    recursive: params.recursive,
                },
                function (err, result) {
                    if (err) report.errors.push(err);
                    else {
                        if (result.zippedFiles.length > 0) {
                            report.results.push(result);
                            report.lastKey =
                                result.zippedFiles[
                                    result.zippedFiles.length - 1
                                ].Key;
                        }

                        /// you may have not zipped anything but you scanned files and there may be more
                        if (result.totalFilesScanned > 0)
                            recursiveLoop(
                                result.lastScannedFile.Key,
                                params.zipFileName.replace(
                                    ".zip",
                                    "_" + counter + ".zip"
                                ),
                                callback
                            );
                        ///you're done time to go home
                        else callback(err, result);

                        counter++;
                        /// clean up your trash you filthy animal
                        garbageCollector(fileStream, result, fragFileName);
                    }
                }
            );
        }

        recursiveLoop(params.startKey, params.zipFileName, function () {
            if (report.errors.length > 0)
                callback(report.errors, report.results);
            else callback(null, report.results);
        });

        return events;
    },
};

module.exports = S3Zipper;

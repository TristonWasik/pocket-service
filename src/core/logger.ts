import winston, { format, transports } from "winston";

export const createLogger = <T = string>(service: T) =>
  winston.createLogger({
    format: format.json({ bigint: true }),
    defaultMeta: { service },
    transports: [
      new transports.Console({
        format: format.combine(
          format.colorize(),
          format.timestamp(),
          format.printf(
            ({ level, message, timestamp, requestId }) =>
              `${timestamp} [${service}] ${level}: ${message}${
                requestId ? ` (req ${requestId})` : ""
              }`,
          ),
        ),
      }),
    ],
  });

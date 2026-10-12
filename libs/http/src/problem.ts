import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
  type LoggerService,
} from '@nestjs/common';

export interface FieldError {
  /** Dotted path of the offending field, e.g. `card.pan`. Never the submitted value. */
  field: string;
  message: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: FieldError[];
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** An error that maps 1:1 to an RFC 9457 Problem Details response (SPEC §6.1). */
export class ProblemException extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.title);
    this.name = 'ProblemException';
  }

  static of(status: number, title: string, detail?: string, errors?: FieldError[]) {
    return new ProblemException({
      type: 'about:blank',
      title,
      status,
      ...(detail === undefined ? {} : { detail }),
      ...(errors === undefined ? {} : { errors }),
    });
  }
}

interface HttpResponseLike {
  status(code: number): HttpResponseLike;
  type(contentType: string): HttpResponseLike;
  setHeader(name: string, value: string): void;
  send(body: string): void;
}

/**
 * Turns every error into `application/problem+json`. Unknown errors become a bare 500:
 * no message, no stack trace, nothing from the request is echoed back (SPEC §6.1, §7).
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly logger?: LoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponseLike>();
    const problem = this.toProblem(exception);
    if (problem.status >= 500) {
      this.logger?.error(
        {
          err:
            exception instanceof Error ? { name: exception.name, message: exception.message } : {},
        },
        'request failed',
      );
    }
    if (problem.status === 429) response.setHeader('Retry-After', '60');
    response.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(problem));
  }

  private toProblem(exception: unknown): ProblemDetails {
    if (exception instanceof ProblemException) return exception.problem;
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return { type: 'about:blank', title: titleFor(status), status };
    }
    if (isBodyParserError(exception)) {
      return { type: 'about:blank', title: titleFor(exception.status), status: exception.status };
    }
    return {
      type: 'about:blank',
      title: titleFor(HttpStatus.INTERNAL_SERVER_ERROR),
      status: HttpStatus.INTERNAL_SERVER_ERROR,
    };
  }
}

/** Errors raised by the JSON body parser (malformed JSON, body too large). */
function isBodyParserError(error: unknown): error is { status: number; type: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    'status' in error &&
    typeof error.status === 'number' &&
    typeof error.type === 'string'
  );
}

const TITLES = new Map<number, string>([
  [400, 'Bad Request'],
  [401, 'Unauthorized'],
  [403, 'Forbidden'],
  [404, 'Not Found'],
  [409, 'Conflict'],
  [413, 'Payload Too Large'],
  [415, 'Unsupported Media Type'],
  [422, 'Unprocessable Content'],
  [429, 'Too Many Requests'],
  [500, 'Internal Server Error'],
  [503, 'Service Unavailable'],
]);

export function titleFor(status: number): string {
  return TITLES.get(status) ?? 'Error';
}

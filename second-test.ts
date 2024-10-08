import { pipe } from "fp-ts/lib/function";
import * as TE from "fp-ts/TaskEither";
import * as NEA from "fp-ts/NonEmptyArray";
import * as R from "fp-ts/Record";
import * as S from "fp-ts/string";
import * as A from "fp-ts/Array";
import * as E from "fp-ts/Either";
import * as J from "fp-ts/Json";
import * as t from "io-ts";
import {
  FetchError,
  POSTError,
  JsonParseError,
  SchemaParseError,
  JsonStringifyError,
  Payment,
  Invoice,
  Invoices,
  OrgSettings,
  PaymentResponse,
  WrongAmountError,
} from "./types";

const invoicesURL = "https://recruiting.api.bemmbo.com/v2/invoices/pending";
const dollarInCLP = 800;

const fetchAPI = TE.tryCatchK(
  (url: string) => fetch(url),
  (err): FetchError => ({
    type: "FetchError" as const,
    error:
      err instanceof Error
        ? err
        : new Error("unexpected error when fetching data"),
  })
);

const sendPOST = (url: string) =>
  TE.tryCatchK(
    (stringifiedData: string) =>
      fetch(url, {
        method: "POST",
        body: stringifiedData,
      }),
    (err): POSTError => ({
      type: "POSTError" as const,
      error:
        err instanceof Error
          ? err
          : new Error("unexpected error when sending POST request"),
    })
  );

const getResponseAsJson = TE.tryCatchK(
  (body: Response) => body.json(),
  (err): JsonParseError => ({
    type: "JsonParseError" as const,
    error:
      err instanceof Error
        ? err
        : new Error("unexpected error when parsing json"),
  })
);

const createResponse = (
  payload: unknown
): E.Either<JsonStringifyError, string> =>
  pipe(
    payload,
    J.stringify,
    E.mapLeft(
      (e): JsonStringifyError => ({
        type: "JsonStringifyError" as const,
        error: E.toError(e),
      })
    )
  );

const parseSchema = <T>(
  content: Record<string, any>,
  schema: t.Decoder<Record<string, any>, T>
) =>
  pipe(
    content,
    schema.decode,
    E.foldW(
      () =>
        TE.left({
          type: "SchemaParseError" as const,
          error: new Error("json does not contain the requested schema"),
        }),
      (data) => TE.right(data)
    )
  );

type OrgBatch = {
  orgCurrency: string;
  invoices: Invoices;
};

const getOrganizationCurrency = (organization_id: string, invoices: Invoices) =>
  pipe(
    organization_id,
    (oId) => `https://recruiting.api.bemmbo.com/organization/${oId}/settings`,
    fetchAPI,
    TE.flatMap(getResponseAsJson),
    TE.flatMap((maybeOrgSettings) =>
      parseSchema(maybeOrgSettings, OrgSettings)
    ),
    TE.map((settings) => settings.currency),
    TE.map(
      (currency): OrgBatch => ({ orgCurrency: currency, invoices: invoices })
    )
  );

const normalizePayment = (payment: Payment, factor: number) => ({
  ...payment,
  amount: Math.round(payment.amount * factor),
});

const normalizeOrgCurrency = (orgBatch: OrgBatch) => {
  const invoices = orgBatch.invoices;
  const currency = orgBatch.orgCurrency;
  return invoices.map((inv) => {
    if (currency === inv.currency) {
      return inv;
    }
    switch (currency) {
      case "CLP": // USD to CLP
        return {
          ...inv,
          amount: inv.amount * dollarInCLP,
          payments: inv.payments
            ? inv.payments.map((pm) => normalizePayment(pm, dollarInCLP))
            : undefined,
          currency: "CLP",
        };
      case "USD": // CLP to USD
        return {
          ...inv,
          amount: Math.round(inv.amount / dollarInCLP),
          payments: inv.payments
            ? inv.payments.map((pm) => normalizePayment(pm, 1 / dollarInCLP))
            : undefined,
          currency: "USD",
        };
      default:
        return inv;
    }
  });
};

const checkPaymentResponse = TE.fromPredicate(
  (response: PaymentResponse) => response.status == "paid",
  (): WrongAmountError => ({
    type: "WrongAmountError" as const,
    error: new Error("the paid amount is not correct"),
  })
);

const payPayment = (paymentId: string, amountToPay: number) =>
  pipe(
    createResponse({ amount: amountToPay }),
    TE.fromEither,
    TE.flatMap(
      sendPOST(`https://recruiting.api.bemmbo.com/payment/${paymentId}/pay`)
    ),
    TE.flatMap(getResponseAsJson),
    TE.flatMap((pr) => parseSchema(pr, PaymentResponse)),
    TE.flatMap(checkPaymentResponse)
  );

type PaymentError =
  | JsonStringifyError
  | JsonParseError
  | POSTError
  | WrongAmountError
  | SchemaParseError;

const processPayments = (payments: Payment[], toReduce: number) => {
  let tasks = [] as TE.TaskEither<PaymentError, PaymentResponse>[];
  payments.reverse().reduce((amountToReduce: number, payment: Payment) => {
    if (payment.status === "paid") {
      return amountToReduce;
    } else if (amountToReduce >= payment.amount) {
      tasks.push(payPayment(payment.id, 0));
      return amountToReduce - payment.amount;
    } else {
      tasks.push(payPayment(payment.id, payment.amount - amountToReduce));
      return 0;
    }
  }, toReduce);
  return tasks;
};

const normalizeInvoicesCurrency = (invoices: Invoices) => pipe(
  invoices,
  NEA.groupBy((inv) => inv.organization_id),
  R.mapWithIndex((orgId, invs) => getOrganizationCurrency(orgId, invs)), // task(orgID) => invoices + config
  R.collect(S.Ord)((_, v) => v),
  A.map((orgElement) => pipe(orgElement, TE.map(normalizeOrgCurrency))),
  A.sequence(TE.ApplicativeSeq),
  TE.map((invsLst) => A.flatten(invsLst))
)

const secondTestMain = async () => {
  const getData = pipe(
    invoicesURL,
    fetchAPI,
    TE.flatMap(getResponseAsJson),
    TE.flatMap((invs) => parseSchema(invs, Invoices)),
    TE.flatMap(normalizeInvoicesCurrency),
  );

  const fetchedData = await getData();
  if (E.isLeft(fetchedData)) {
    // On error, return
    return;
  }

  const invoices = fetchedData.right;
  const creditNotes = invoices.filter((inv) => inv.type === "credit_note");
  const receivedInvs = invoices
    .filter((inv) => inv.type === "received")
    .filter((inv) => inv.payments);

  const payInvoices = pipe(
    receivedInvs,
    A.map((inv) => {
      const cnForInvoice = creditNotes.filter((cn) => cn.reference === inv.id);
      const toReduce = cnForInvoice.reduce(
        (acc: number, cn: Invoice) => acc + cn.amount,
        0
      );
      return processPayments(inv.payments ? inv.payments : [], toReduce);
    }),
    A.flatten,
    A.sequence(TE.ApplicativeSeq)
  );

  const result = await payInvoices();
  if (E.isLeft(result)) {
    console.error(result.left);
    return;
  }
  console.log(result.right);
};
secondTestMain();

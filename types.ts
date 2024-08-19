import * as t from 'io-ts'


export const Payment = t.type({
    id: t.string,
    amount: t.number,
    status: t.string,
})

export const Invoice = t.type({
    id: t.string,
    amount: t.number,
    organization_id: t.string,
    currency: t.string,
    type: t.string,
    reference: t.union([t.string, t.undefined]),
    payments: t.union([t.array(Payment), t.undefined]),
})

export const Invoices = t.array(Invoice)

export const OrgSettings = t.type({
    organization_id: t.string,
    currency: t.string,
})

export const PaymentResponse = t.type({
    status: t.string
})

export type Payment = t.TypeOf<typeof Payment>
export type Invoice = t.TypeOf<typeof Invoice>
export type Invoices = t.TypeOf<typeof Invoices>
export type OrgSettings = t.TypeOf<typeof OrgSettings>
export type PaymentResponse = t.TypeOf<typeof PaymentResponse>

// Errors
export type FetchError = {
    type: 'FetchError'
    error: Error
}

export type POSTError = {
    type: 'POSTError'
    error: Error
}

export type JSONParseError = {
    type: 'JSONParseError'
    error: Error
}

export type SchemaParseError = {
    type: 'SchemaParseError'
    error: Error
}

export type JsonStringifyError = Readonly<{
    type: 'JsonStringifyError'
    error: Error
}>

export type WrongAmountError = Readonly<{
    type: 'WrongAmountError'
    error: Error
}>

package payment

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

// AsaasURL overrides the Asaas API base (tests point it at a fake server). When empty, ASAAS_API_URL is
// used (read on every call, after .env is loaded), falling back to the sandbox. Production:
// ASAAS_API_URL=https://api.asaas.com/v3
var AsaasURL = ""

func apiBase() string {
	if AsaasURL != "" {
		return strings.TrimRight(AsaasURL, "/")
	}
	if u := strings.TrimSpace(os.Getenv("ASAAS_API_URL")); u != "" {
		return strings.TrimRight(u, "/")
	}
	return "https://sandbox.asaas.com/api/v3"
}

type AsaasClient struct {
	APIKey string
}

func NewAsaasClient(apiKey string) *AsaasClient {
	return &AsaasClient{APIKey: apiKey}
}

type CustomerRequest struct {
	Name          string `json:"name,omitempty"`
	CpfCnpj       string `json:"cpfCnpj,omitempty"`
	Email         string `json:"email,omitempty"`
	MobilePhone   string `json:"mobilePhone,omitempty"`
	PostalCode    string `json:"postalCode,omitempty"`
	Address       string `json:"address,omitempty"`
	AddressNumber string `json:"addressNumber,omitempty"`
	Complement    string `json:"complement,omitempty"`
	Province      string `json:"province,omitempty"`
	ExternalRef   string `json:"externalReference,omitempty"`
	Notification  bool   `json:"notificationDisabled"`
}

type CustomerResponse struct {
	ID string `json:"id"`
}

type PaymentRequest struct {
	Customer         string      `json:"customer"`
	BillingType      string      `json:"billingType"` // "PIX", "CREDIT_CARD", "BOLETO"
	Value            float64     `json:"value"`
	DueDate          string      `json:"dueDate"`
	InstallmentCount int         `json:"installmentCount,omitempty"`
	InstallmentValue float64     `json:"installmentValue,omitempty"`
	Description      string      `json:"description,omitempty"`
	ExternalRef      string      `json:"externalReference,omitempty"`
	CreditCard       *CreditCard `json:"creditCard,omitempty"`
	CreditCardHolder *CardHolder `json:"creditCardHolderInfo,omitempty"`
}

type CreditCard struct {
	HolderName  string `json:"holderName"`
	Number      string `json:"number"`
	ExpiryMonth string `json:"expiryMonth"`
	ExpiryYear  string `json:"expiryYear"`
	CCV         string `json:"ccv"`
}

type CardHolder struct {
	Name          string `json:"name"`
	Email         string `json:"email"`
	CpfCnpj       string `json:"cpfCnpj"`
	PostalCode    string `json:"postalCode"`
	AddressNumber string `json:"addressNumber"`
	Phone         string `json:"phone,omitempty"`
	MobilePhone   string `json:"mobilePhone,omitempty"`
}

type PaymentResponse struct {
	ID          string  `json:"id"`
	Status      string  `json:"status"`
	InvoiceUrl  string  `json:"invoiceUrl,omitempty"`
	BankSlipUrl string  `json:"bankSlipUrl,omitempty"`
	PixQrCode   string  `json:"pixQrCode,omitempty"` // Sometimes delivered differently for PIX
	Value       float64 `json:"value"`
}

func (c *AsaasClient) CreateCustomer(req CustomerRequest) (string, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return "", err
	}

	reqHttp, err := http.NewRequest("POST", fmt.Sprintf("%s/customers", apiBase()), bytes.NewBuffer(body))
	if err != nil {
		return "", err
	}

	c.setHeaders(reqHttp)

	client := &http.Client{}
	resp, err := client.Do(reqHttp)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("failed to create customer: %s", string(respBody))
	}

	var result CustomerResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", err
	}

	return result.ID, nil
}

func (c *AsaasClient) UpdateCustomer(customerID string, req CustomerRequest) error {
	body, err := json.Marshal(req)
	if err != nil {
		return err
	}

	reqHttp, err := http.NewRequest("POST", fmt.Sprintf("%s/customers/%s", apiBase(), customerID), bytes.NewBuffer(body))
	if err != nil {
		return err
	}

	c.setHeaders(reqHttp)

	client := &http.Client{}
	resp, err := client.Do(reqHttp)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to update customer: %s", string(respBody))
	}

	return nil
}

func (c *AsaasClient) CreatePayment(req PaymentRequest) (*PaymentResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	reqHttp, err := http.NewRequest("POST", fmt.Sprintf("%s/payments", apiBase()), bytes.NewBuffer(body))
	if err != nil {
		return nil, err
	}

	c.setHeaders(reqHttp)

	client := &http.Client{}
	resp, err := client.Do(reqHttp)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("failed to create payment: %s", string(respBody))
	}

	var result PaymentResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, err
	}

	// If it's PIX, we might need extra call to get QR Code, but typically 'status' and 'invoiceUrl' are returned.
	// For direct PIX data, Asaas has a separate endpoint: GET /payments/{id}/pixQrCode

	return &result, nil
}

// SubscriptionRequest defines the payload for creating a subscription
type SubscriptionRequest struct {
	Customer         string      `json:"customer"`
	BillingType      string      `json:"billingType"` // "PIX", "CREDIT_CARD", "BOLETO"
	Value            float64     `json:"value"`
	NextDueDate      string      `json:"nextDueDate"`
	Cycle            string      `json:"cycle"` // "MONTHLY", "YEARLY"
	InstallmentCount int         `json:"installmentCount,omitempty"`
	InstallmentValue float64     `json:"installmentValue,omitempty"`
	Description      string      `json:"description,omitempty"`
	ExternalRef      string      `json:"externalReference,omitempty"`
	CreditCard       *CreditCard `json:"creditCard,omitempty"`
	CreditCardHolder *CardHolder `json:"creditCardHolderInfo,omitempty"`
}

// SubscriptionResponse defines the response after creating a subscription
type SubscriptionResponse struct {
	ID          string  `json:"id"`
	Status      string  `json:"status"` // "ACTIVE", "EXPIRED"
	Value       float64 `json:"value"`
	Description string  `json:"description"`
	Cycle       string  `json:"cycle"`
	BillingType string  `json:"billingType"`
	DateCreated string  `json:"dateCreated"`
	NextDueDate string  `json:"nextDueDate"`
}

func (c *AsaasClient) CreateSubscription(req SubscriptionRequest) (*SubscriptionResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	reqHttp, err := http.NewRequest("POST", fmt.Sprintf("%s/subscriptions", apiBase()), bytes.NewBuffer(body))
	if err != nil {
		return nil, err
	}

	c.setHeaders(reqHttp)

	client := &http.Client{}
	resp, err := client.Do(reqHttp)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("failed to create subscription: %s", string(respBody))
	}

	var result SubscriptionResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, err
	}

	return &result, nil
}

func (c *AsaasClient) GetSubscription(id string) (*SubscriptionResponse, error) {
	reqHttp, err := http.NewRequest("GET", fmt.Sprintf("%s/subscriptions/%s", apiBase(), id), nil)
	if err != nil {
		return nil, err
	}

	c.setHeaders(reqHttp)

	client := &http.Client{}
	resp, err := client.Do(reqHttp)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failed to get subscription: %s", string(respBody))
	}

	var result SubscriptionResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, err
	}

	return &result, nil
}

func (c *AsaasClient) DeleteSubscription(id string) error {
	reqHttp, err := http.NewRequest("DELETE", fmt.Sprintf("%s/subscriptions/%s", apiBase(), id), nil)
	if err != nil {
		return err
	}

	c.setHeaders(reqHttp)

	client := &http.Client{}
	resp, err := client.Do(reqHttp)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("failed to delete subscription: %s", string(respBody))
	}

	return nil
}

func (c *AsaasClient) ListSubscriptionPayments(subscriptionId string) ([]PaymentResponse, error) {
	reqHttp, err := http.NewRequest("GET", fmt.Sprintf("%s/subscriptions/%s/payments", apiBase(), subscriptionId), nil)
	if err != nil {
		return nil, err
	}

	c.setHeaders(reqHttp)

	client := &http.Client{}
	resp, err := client.Do(reqHttp)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failed to list subscription payments: %s", string(respBody))
	}

	type ListPaymentResponse struct {
		Data []PaymentResponse `json:"data"`
	}

	var result ListPaymentResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, err
	}

	return result.Data, nil
}

func (c *AsaasClient) GetPixQrCode(paymentId string) (string, string, error) {
	reqHttp, err := http.NewRequest("GET", fmt.Sprintf("%s/payments/%s/pixQrCode", apiBase(), paymentId), nil)
	if err != nil {
		return "", "", err
	}

	c.setHeaders(reqHttp)

	client := &http.Client{}
	resp, err := client.Do(reqHttp)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("failed to get pix qrcode: %s", string(respBody))
	}

	type PixResponse struct {
		EncodedImage string `json:"encodedImage"`
		Payload      string `json:"payload"`
	}

	var result PixResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", "", err
	}

	return result.EncodedImage, result.Payload, nil
}

func (c *AsaasClient) setHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("access_token", c.APIKey)
}

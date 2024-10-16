import { config as loadEnv } from "dotenv";
import {
  createWalletClient,
  http,
  getContract,
  erc20Abi,
  parseUnits,
  maxUint256,
  publicActions,
  concat,
  numberToHex,
  size,
} from "viem";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { scroll } from "viem/chains";
import { wethAbi } from "./abi/weth-abi";

/* Pour le défi 0x sur Scroll :
 
1. Afficher la répartition des sources de liquidité en pourcentage
2. Monétiser avec les frais d'affiliation et la collecte de surplus
3. Afficher les taxes d'achat/vente pour les tokens
4. Lister toutes les sources de liquidité disponibles sur Scroll
 
*/

const queryString = require("qs");

// Charger les variables d'environnement
loadEnv();
const { PRIVATE_KEY, ZERO_EX_API_KEY, ALCHEMY_HTTP_TRANSPORT_URL } =
  process.env;

// Vérification des variables requises
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY manquant.");
if (!ZERO_EX_API_KEY) throw new Error("ZERO_EX_API_KEY manquant.");
if (!ALCHEMY_HTTP_TRANSPORT_URL)
  throw new Error("ALCHEMY_HTTP_TRANSPORT_URL manquant.");

// Définir les headers de requête
const requestHeaders = new Headers({
  "Content-Type": "application/json",
  "0x-api-key": ZERO_EX_API_KEY,
  "0x-version": "v2",
});

// Configurer le client du portefeuille
const wallet = createWalletClient({
  account: privateKeyToAccount(`0x${PRIVATE_KEY}` as `0x${string}`),
  chain: scroll,
  transport: http(ALCHEMY_HTTP_TRANSPORT_URL),
}).extend(publicActions); // Ajouter des actions publiques au client

const [userAddress] = await wallet.getAddresses();

// Configurer les contrats
const wethContract = getContract({
  address: "0x5300000000000000000000000000000000000004",
  abi: wethAbi,
  client: wallet,
});
const wstEthContract = getContract({
  address: "0xf610A9dfB7C89644979b4A0f27063E9e7d7Cda32",
  abi: erc20Abi,
  client: wallet,
});

// Fonction pour afficher la répartition des sources de liquidité
function showLiquiditySources(route: any) {
  const liquidityFills = route.fills;
  const totalPercentage = liquidityFills.reduce((acc: number, fill: any) => acc + parseInt(fill.proportionBps), 0);

  console.log(`${liquidityFills.length} Sources de liquidité :`);
  liquidityFills.forEach((fill: any) => {
    const proportion = (parseInt(fill.proportionBps) / 100).toFixed(2);
    console.log(`${fill.source} : ${proportion}%`);
  });
}

// Fonction pour afficher les taxes sur les tokens
function showTokenTaxes(tokenMetadata: any) {
  const buyTokenBuyTax = (parseInt(tokenMetadata.buyToken.buyTaxBps) / 100).toFixed(2);
  const buyTokenSellTax = (parseInt(tokenMetadata.buyToken.sellTaxBps) / 100).toFixed(2);
  const sellTokenBuyTax = (parseInt(tokenMetadata.sellToken.buyTaxBps) / 100).toFixed(2);
  const sellTokenSellTax = (parseInt(tokenMetadata.sellToken.sellTaxBps) / 100).toFixed(2);

  if (buyTokenBuyTax > 0 || buyTokenSellTax > 0) {
    console.log(`Taxe d'achat du token d'achat : ${buyTokenBuyTax}%`);
    console.log(`Taxe de vente du token d'achat : ${buyTokenSellTax}%`);
  }

  if (sellTokenBuyTax > 0 || sellTokenSellTax > 0) {
    console.log(`Taxe d'achat du token de vente : ${sellTokenBuyTax}%`);
    console.log(`Taxe de vente du token de vente : ${sellTokenSellTax}%`);
  }
}

// Fonction pour lister toutes les sources de liquidité sur Scroll
const listLiquiditySources = async () => {
  const chainId = wallet.chain.id.toString(); // S'assurer que l'ID de la chaîne est correct pour Scroll
  const queryParameters = new URLSearchParams({
    chainId: chainId,
  });

  const response = await fetch(
    `https://api.0x.org/swap/v1/sources?${queryParameters.toString()}`,
    {
      headers: requestHeaders,
    }
  );

  const responseData = await response.json();
  const liquiditySources = Object.keys(responseData.sources);
  console.log("Sources de liquidité disponibles sur Scroll:");
  console.log(liquiditySources.join(", "));
};

// Fonction principale
const execute = async () => {
  // Étape 4 : Afficher toutes les sources de liquidité sur Scroll
  await listLiquiditySources();

  // Définir le montant à vendre
  const wethDecimals = (await wethContract.read.decimals()) as number;
  const amountToSell = parseUnits("0.1", wethDecimals);

  // Étape 2 : Ajouter les paramètres de frais d'affiliation et de surplus
  const affiliateFeeBasisPoints = "100"; // 1% de frais d'affiliation
  const enableSurplus = "true"; // Activer la collecte de surplus

  // Étape 1 : Obtenir le prix avec les paramètres de monétisation
  const priceQuery = new URLSearchParams({
    chainId: wallet.chain.id.toString(),
    sellToken: wethContract.address,
    buyToken: wstEthContract.address,
    sellAmount: amountToSell.toString(),
    taker: wallet.account.address,
    affiliateFee: affiliateFeeBasisPoints, // Paramètre de frais d'affiliation
    surplusCollection: enableSurplus, // Paramètre de collecte de surplus
  });

  const priceResult = await fetch(
    `https://api.0x.org/swap/permit2/price?${priceQuery.toString()}`,
    {
      headers: requestHeaders,
    }
  );

  const priceData = await priceResult.json();
  console.log("Prix pour échanger 0.1 WETH contre wstETH:");
  console.log(priceData);

  // Étape 2 : Vérifier si une approbation pour Permit2 est nécessaire
  if (priceData.issues.allowance !== null) {
    try {
      const approvalData = await wethContract.simulate.approve([
        priceData.issues.allowance.spender,
        maxUint256,
      ]);
      console.log("Approbation en cours pour Permit2...");
      const approvalTxHash = await wethContract.write.approve(approvalData.args);
      console.log("Transaction d'approbation pour Permit2 :", approvalTxHash);
    } catch (error) {
      console.error("Erreur lors de l'approbation pour Permit2 :", error);
    }
  } else {
    console.log("Aucune approbation nécessaire pour Permit2.");
  }

  // Étape 3 : Obtenir un devis pour l'échange
  const quoteQuery = new URLSearchParams();
  for (const [key, value] of priceQuery.entries()) {
    quoteQuery.append(key, value);
  }

  const quoteResponse = await fetch(
    `https://api.0x.org/swap/permit2/quote?${quoteQuery.toString()}`,
    {
      headers: requestHeaders,
    }
  );

  const quoteData = await quoteResponse.json();
  console.log("Devis pour échanger 0.1 WETH contre wstETH:");
  console.log(quoteData);

  // Étape 1 : Afficher la répartition des sources de liquidité
  if (quoteData.route) {
    showLiquiditySources(quoteData.route);
  }

  // Étape 3 : Afficher les taxes sur les tokens
  if (quoteData.tokenMetadata) {
    showTokenTaxes(quoteData.tokenMetadata);
  }

  // Étape 2 : Afficher les informations de monétisation
  if (quoteData.affiliateFeeBps) {
    const affiliateFee = (parseInt(quoteData.affiliateFeeBps) / 100).toFixed(2);
    console.log(`Frais d'affiliation : ${affiliateFee}%`);
  }

  if (quoteData.tradeSurplus && parseFloat(quoteData.tradeSurplus) > 0) {
    console.log(`Surplus collecté : ${quoteData.tradeSurplus}`);
  }

  // Logique de signature et d'envoi de la transaction...
};

execute();

import React, { useState } from 'react';
import { Icon } from './icons.jsx';
import acidoAcetilsalicilico from '../assets/store/products/acido_acetilsalicilico_100mg_100_tabletas.png';
import aguaOxigenada from '../assets/store/products/agua_oxigenada_10_vol_120ml.png';
import alcoholGel from '../assets/store/products/alcohol_en_gel_500ml.png';
import alcoholMedicinal from '../assets/store/products/alcohol_medicinal_70_500ml.png';
import algodonHidrofilo from '../assets/store/products/algodon_hidrofilo_100g.png';
import amoxicilina from '../assets/store/products/amoxicilina_500mg_100_capsulas.png';

/**
 * Fuente ÚNICA de imágenes de producto para la tienda y el panel administrativo.
 *
 * Prioridad: 1) imageUrl de la API (imagen subida desde el panel); 2) fotografía local empaquetada por Vite,
 * indexada por el ID real del producto; 3) marcador de Pharma Plus. Si una fuente falla al cargar se pasa a la
 * siguiente. Los productos sin entrada aquí conservan el marcador.
 */
export const PRODUCT_IMAGES = Object.freeze({
  196: acidoAcetilsalicilico,
  202: aguaOxigenada,
  203: alcoholGel,
  201: alcoholMedicinal,
  204: algodonHidrofilo,
  212: amoxicilina,
});

/** Fuentes a intentar, en orden y sin duplicados. Acepta productos ({id}) y líneas de pedido/carrito ({productId}). */
export function productImageSources(p) {
  if (!p) return [];
  const local = PRODUCT_IMAGES[Number(p.productId ?? p.id)];
  return [p.imageUrl, local].filter((src, i, all) => src && all.indexOf(src) === i);
}

export function hasProductImage(product) {
  return productImageSources(product).length > 0;
}

/**
 * Imagen del producto con alternativas. El contador de fallos va ligado a la lista de fuentes: si el producto
 * cambia (nueva página, búsqueda, recarga tras editar o subir imagen) se reinicia sin depender de `key`.
 */
export function ProductImage({ product, alt = '', loading = 'lazy', className = 'st-photo', placeholderClassName }) {
  const sources = productImageSources(product);
  const sig = sources.join('\n');
  const [fail, setFail] = useState({ sig, n: 0 });
  const n = fail.sig === sig ? fail.n : 0;
  const src = sources[n];
  if (!src) return <Icon name="pill" className={placeholderClassName ? `ico ${placeholderClassName}` : 'ico'} />;
  return (
    <img
      key={src} className={className} src={src} alt={alt} loading={loading} decoding="async" data-product-id={product.productId ?? product.id}
      onError={() => setFail({ sig, n: n + 1 })}
    />
  );
}

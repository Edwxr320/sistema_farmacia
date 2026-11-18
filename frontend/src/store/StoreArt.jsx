import React from 'react';
import heroLight from '../assets/store/hero-art-light.png';
import heroDark from '../assets/store/hero-art-dark.png';

/**
 * Ilustración del banner principal: recursos extraídos de la referencia aprobada
 * (Bocetos/Interfaz Pharma Plus en claro y oscuro.png), una versión por tema.
 * Es decorativa (alt vacío); el texto, el botón y los datos del banner son componentes reales.
 */
export const HERO_ART = { light: heroLight, dark: heroDark };

export function HeroArt({ theme, className }) {
  return <img className={className} src={HERO_ART[theme] || heroLight} alt="" aria-hidden="true" width="686" height="388" decoding="async" />;
}
